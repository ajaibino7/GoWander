// Photos that fade in once they've loaded, instead of popping in (or painting in strips) a moment
// after the page. A photo already shown this session appears at once.
import { useEffect, useState } from 'react';

const loaded = new Set<string>();

/** 'on' once the image has loaded; 'instant' too when it was already loaded (no fade). */
export function useImageReady(url: string | null | undefined): string {
  const [state, setState] = useState(() => ({ url, ready: !!url && loaded.has(url), instant: !!url && loaded.has(url) }));
  let cur = state;
  if (state.url !== url) { // a different photo: start again
    cur = { url, ready: !!url && loaded.has(url), instant: !!url && loaded.has(url) };
    setState(cur);
  }
  useEffect(() => {
    if (!url || loaded.has(url)) return undefined;
    let gone = false;
    const img = new Image();
    img.decoding = 'async';
    // Errors count as "loaded" too: the layer then just shows the artwork underneath.
    img.onload = img.onerror = () => {
      loaded.add(url);
      if (!gone) setState((s) => (s.url === url ? { ...s, ready: true } : s));
    };
    img.src = url;
    return () => { gone = true; };
  }, [url]);
  return cur.ready ? (cur.instant ? 'on instant' : 'on') : '';
}

/** An <img> that fades in when loaded. */
export function FadeImg({ src, className = '', alt = '' }: { src: string; className?: string; alt?: string }) {
  const ready = useImageReady(src);
  return <img className={`fade-img ${className} ${ready}`.trim()} src={src} alt={alt} decoding="async" draggable={false} />;
}
