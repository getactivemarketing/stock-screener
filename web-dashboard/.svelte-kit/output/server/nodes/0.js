

export const index = 0;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_layout.svelte.js')).default;
export const imports = ["_app/immutable/nodes/0.BpkiTz8P.js","_app/immutable/chunks/IdZxz9_D.js","_app/immutable/chunks/CJVWN2P9.js","_app/immutable/chunks/Ng2YzemH.js"];
export const stylesheets = ["_app/immutable/assets/0.CfqnsMuM.css"];
export const fonts = [];
