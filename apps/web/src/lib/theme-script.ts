// Kept free of 'use client' so the server layout can inline the script as a plain string.
export const THEME_STORAGE_KEY = 'cph-theme';

/** Runs before first paint (inlined in the root layout) so there is no flash of the wrong theme. */
export const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem('${THEME_STORAGE_KEY}');var d=p==='dark'||(p!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.dataset.theme=d?'dark':'light';r.style.colorScheme=d?'dark':'light';}catch(e){}})();`;
