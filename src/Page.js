let chokidar = require("chokidar");
let fs = require("flowfs");
let url = require("url");
let cmd = require("./utils/cmd");
let sleep = require("./utils/sleep");
let validIdentifier = require("./utils/validIdentifier");
let instantiateSsrModule = require("./utils/instantiateSsrModule");
let isElectron = require("./utils/isElectron");
let payload = require("./payload");

/*
in dev, we want to know which pages we're currently looking at so we can
schedule them for priority rebuilding when a common dependency is changed

this defines how long after the last websocket hearbeat to consider a page
no longer active
*/

let idleTimeout = 1000 * 15;

module.exports = class {
	constructor(engine, path) {
		let {
			config,
			scheduler,
			template,
			liveReload,
		} = engine;
		
		let {
			dir,
			buildDir,
			assetsPrefix,
		} = config;
		
		this.engine = engine;
		this.path = path;
		this.relativePath = fs(path).pathFrom(dir);
		this.name = validIdentifier(fs(path).basename);
		
		this.config = config;
		this.scheduler = scheduler;
		this.template = template;
		this.liveReload = liveReload;
		
		this.ready = false;
		
		let base = fs(path).reparent(dir, buildDir);
		
		this.buildFile = base.withExt(".json");
		this.jsPath = assetsPrefix + base.reExt(".js").pathFrom(buildDir);
		this.cssPath = assetsPrefix + base.reExt(".css").pathFrom(buildDir);
		
		this.active = false;
		
		if (this.liveReload) {
			this.liveReload.socket.on("connection", (ws) => {
				ws.setMaxListeners(0);
				
				ws.on("message", (path) => {
					if (path === this.path) {
						this.heartbeat();
					}
				});
			});
		}
	}
	
	async runBuildScript() {
		let {
			name,
			path,
			config,
			buildFile,
		} = this;
		
		let {
			dir,
			buildScript,
		} = config;
		
		let json = JSON.stringify({
			name,
			path,
			buildPath: buildFile.path,
			config,
		});
		
		await cmd(`node ${buildScript} '${json}'`, json);
	}
	
	async build() {
		let buildTimer = "Build " + this.relativePath;
		
		console.time(buildTimer);
		
		await this.runBuildScript();
		await this.init();
		
		console.timeEnd(buildTimer);
	}
	
	async init(priority=false) {
		if (!await this.buildFile.exists()) {
			return this.scheduler.build(this, priority);
		}
		
		try {
			let {
				client,
				server,
				hashes,
			} = await this.buildFile.readJson();
			
			this.serverComponent = server;
			this.clientComponent = client;
			this.hashes = hashes || {};
			
			if (this.serverComponent) {
				this.ssrModule = await instantiateSsrModule(this.serverComponent.component, this.path);
			}
		} catch (e) {
			this.buildFile.deleteIfExists();
			
			throw e;
		}
		
		if (this.config.watch) {
			if (this.watcher) {
				this.watcher.close();
			}
			
			this.watcher = chokidar.watch(this.clientComponent.watchFiles);
			
			this.watcher.on("change", async (path) => {
				this.ready = false;
				
				if (!isElectron && !this.active) {
					// give active pages a chance to get scheduled first
					await sleep(100);
				}
				
				this.scheduler.scheduleBuild(this, this.active);
			});
			
			if (this.config.liveReload) {
				if (isElectron) {
					let {BrowserWindow} = require("electron");
					
					for (let win of BrowserWindow.getAllWindows()) {
						let winUrl = win.getURL();
						
						if (winUrl) {
							if (url.parse(winUrl).pathname === this.path) {
								win.webContents.reloadIgnoringCache();
							}
						}
					}
				} else {
					for (let client of this.liveReload.socket.clients) {
						client.send(this.path);
					}
				}
			}
		}
		
		this.ready = true;
	}
	
	heartbeat() {
		this.active = true;
		
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
		}
		
		this.idleTimer = setTimeout(() => {
			this.active = false;
			this.idleTimer = null;
		}, idleTimeout);
	}
	
	async render(locals, forEmail=false) {
		if (locals._rebuild) {
			await this.build();
		}
		
		if (!this.ready) {
			await this.init(true);
		}
		
		let _head = false; // HACK https://github.com/sveltejs/svelte/issues/4982
		
		locals = {
			__headOnce() {
				if (_head) {
					return false;
				}
				
				_head = true;
				
				return true;
			},
			
			...locals,
		};
		
		payload.set(locals);
		
		/*
		pre-render hook for setting/clearing stores
		*/
		
		if (this.config.prerender) {
			this.config.prerender(locals);
		}
		
		/*
		note that we don't use .css from render() - this only includes CSS for
		child components that happen to be rendered this time.  we use
		serverComponent.css, which has CSS for all components that are imported
		(ie all components that could possibly be rendered)
		*/
		
		let head = "";
		let html = "";
		let css = "";
		
		if (this.serverComponent) {
			let module = this.ssrModule["default"] || this.ssrModule;
			
			({head, html} = module.render(locals));
			
			if (this.config.env !== "dev") {
				({css} = this.serverComponent);
			}
		}
		
		let {js} = this.clientComponent;
		
		let json = JSON.stringify(locals);
		let props = json;
		
		if (this.config.payloadFormat === "templateString") {
			props = "`" + json.replace(/\\/g, "\\\\") + "`";
		}
		
		if (this.liveReload) {
			head += `
				<script>
					var socket;
					
					function createSocket() {
						socket = new WebSocket("ws://" + location.hostname + ":${this.liveReload.port}");
						
						socket.addEventListener("message", function(message) {
							if (message.data === "${this.path}") {
								location.reload();
							}
						});
						
						socket.addEventListener("close", function() {
							setTimeout(createSocket, 500);
						});
					}
					
					function heartbeat() {
						socket.send("${this.path}");
					}
					
					createSocket();
					
					setInterval(heartbeat, 1000);
				</script>
			`;
		}
		
		if (forEmail) {
			return html;
		} else {
			let {
				name,
				jsPath,
				cssPath,
			} = this;
			
			return this.template.render({
				head,
				html,
				css: css.code,
				js: js.code,
				jsPath,
				cssPath,
				jsHash: this.hashes.js,
				cssHash: this.hashes.css,
				name,
				props,
			});
		}
	}
}
