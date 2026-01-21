import * as server from '../entries/pages/_page.server.ts.js';

export const index = 2;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_page.svelte.js')).default;
export { server };
export const server_id = "src/routes/+page.server.ts";
export const imports = ["_app/immutable/nodes/2.C_NTbWQ4.js","_app/immutable/chunks/IdZxz9_D.js","_app/immutable/chunks/CJVWN2P9.js","_app/immutable/chunks/Ng2YzemH.js","_app/immutable/chunks/D7XHfT7T.js","_app/immutable/chunks/CciVzwLS.js","_app/immutable/chunks/DMUSPNmw.js","_app/immutable/chunks/X8ZlJyyB.js"];
export const stylesheets = [];
export const fonts = [];
