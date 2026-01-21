
// this file is generated — do not edit it


declare module "svelte/elements" {
	export interface HTMLAttributes<T> {
		'data-sveltekit-keepfocus'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-noscroll'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-preload-code'?:
			| true
			| ''
			| 'eager'
			| 'viewport'
			| 'hover'
			| 'tap'
			| 'off'
			| undefined
			| null;
		'data-sveltekit-preload-data'?: true | '' | 'hover' | 'tap' | 'off' | undefined | null;
		'data-sveltekit-reload'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-replacestate'?: true | '' | 'off' | undefined | null;
	}
}

export {};


declare module "$app/types" {
	export interface AppTypes {
		RouteId(): "/" | "/analytics" | "/api" | "/api/analytics" | "/api/screener" | "/api/sectors" | "/api/ticker" | "/api/ticker/[symbol]" | "/api/webull" | "/portfolio" | "/sectors" | "/ticker" | "/ticker/[symbol]";
		RouteParams(): {
			"/api/ticker/[symbol]": { symbol: string };
			"/ticker/[symbol]": { symbol: string }
		};
		LayoutParams(): {
			"/": { symbol?: string };
			"/analytics": Record<string, never>;
			"/api": { symbol?: string };
			"/api/analytics": Record<string, never>;
			"/api/screener": Record<string, never>;
			"/api/sectors": Record<string, never>;
			"/api/ticker": { symbol?: string };
			"/api/ticker/[symbol]": { symbol: string };
			"/api/webull": Record<string, never>;
			"/portfolio": Record<string, never>;
			"/sectors": Record<string, never>;
			"/ticker": { symbol?: string };
			"/ticker/[symbol]": { symbol: string }
		};
		Pathname(): "/" | "/analytics" | "/analytics/" | "/api" | "/api/" | "/api/analytics" | "/api/analytics/" | "/api/screener" | "/api/screener/" | "/api/sectors" | "/api/sectors/" | "/api/ticker" | "/api/ticker/" | `/api/ticker/${string}` & {} | `/api/ticker/${string}/` & {} | "/api/webull" | "/api/webull/" | "/portfolio" | "/portfolio/" | "/sectors" | "/sectors/" | "/ticker" | "/ticker/" | `/ticker/${string}` & {} | `/ticker/${string}/` & {};
		ResolvedPathname(): `${"" | `/${string}`}${ReturnType<AppTypes['Pathname']>}`;
		Asset(): "/favicon.png" | string & {};
	}
}