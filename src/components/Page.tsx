// Every screen: its header, the screen itself (sliding in from the side you're heading), and the
// footer line.
import type { ReactNode } from 'react';
import { Hero, type HeroProps } from './Hero';
import { useEnterClass } from '../app/motion';

interface PageProps {
  hero: HeroProps;
  foot?: string;
  /** The screen's id — styles key off some of them (#view-home, #view-trip, #view-edit…). */
  viewId: string;
  /** 'wrap-narrow' (single column) or 'wrap' (the trip page's two columns). */
  layout?: 'wrap-narrow' | 'wrap';
  children: ReactNode;
}

export function Page({ hero, foot = '', viewId, layout = 'wrap-narrow', children }: PageProps) {
  const enter = useEnterClass();
  return (
    <>
      <Hero {...hero} enter={enter} />
      <main>
        <section id={viewId} className={`view ${layout} ${enter}`.trim()}>{children}</section>
      </main>
      <footer className="site-foot">{foot}</footer>
    </>
  );
}

/** A placeholder screen while a trip loads (the header and a skeleton card, no blank flash). */
export function PageLoading({ viewId, eyebrow = 'GoWander', back, tripId = null }: { viewId: string; eyebrow?: string; back?: ReactNode; tripId?: string | null }) {
  return (
    <Page viewId={viewId} hero={{ eyebrow, title: '', nav: back, tripId }}>
      <div className="home-skel" aria-hidden="true"><div className="sk-card" /></div>
    </Page>
  );
}
