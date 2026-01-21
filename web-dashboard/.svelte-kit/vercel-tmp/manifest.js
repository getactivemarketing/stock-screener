export const manifest = (() => {
function __memo(fn) {
	let value;
	return () => value ??= (value = fn());
}

return {
	appDir: "_app",
	appPath: "_app",
	assets: new Set(["favicon.png"]),
	mimeTypes: {".png":"image/png"},
	_: {
		client: {start:"_app/immutable/entry/start.jqz1czOd.js",app:"_app/immutable/entry/app.CMO3fONn.js",imports:["_app/immutable/entry/start.jqz1czOd.js","_app/immutable/chunks/COrPzqku.js","_app/immutable/chunks/CJVWN2P9.js","_app/immutable/chunks/C2VAiQjl.js","_app/immutable/entry/app.CMO3fONn.js","_app/immutable/chunks/CJVWN2P9.js","_app/immutable/chunks/D7XHfT7T.js","_app/immutable/chunks/IdZxz9_D.js","_app/immutable/chunks/C2VAiQjl.js","_app/immutable/chunks/CciVzwLS.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
		nodes: [
			__memo(() => import('../output/server/nodes/0.js')),
			__memo(() => import('../output/server/nodes/1.js')),
			__memo(() => import('../output/server/nodes/2.js')),
			__memo(() => import('../output/server/nodes/3.js'))
		],
		remotes: {
			
		},
		routes: [
			{
				id: "/",
				pattern: /^\/$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 2 },
				endpoint: null
			},
			{
				id: "/ticker/[symbol]",
				pattern: /^\/ticker\/([^/]+?)\/?$/,
				params: [{"name":"symbol","optional":false,"rest":false,"chained":false}],
				page: { layouts: [0,], errors: [1,], leaf: 3 },
				endpoint: null
			}
		],
		prerendered_routes: new Set([]),
		matchers: async () => {
			
			return {  };
		},
		server_assets: {}
	}
}
})();
