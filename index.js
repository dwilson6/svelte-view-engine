let Page = require("./src/Page");
let Template = require("./src/Template");
let merge = require("lodash.merge");

module.exports = (opts) => {
	let dev = process.env.NODE_ENV !== "production";
	
	let options = merge({
		template: null,
		watch: dev,
		liveReload: dev,
		minify: !dev,
		svelte: {
			dev,
		},
	}, opts);
	
	let pages = {};
	let template = new Template(options.template, options);
	
	return async (path, locals, callback) => {
		if (!pages[path]) {
			pages[path] = new Page(template, path, options);
		}
		
		callback(null, await pages[path].render(locals));
	}
}
