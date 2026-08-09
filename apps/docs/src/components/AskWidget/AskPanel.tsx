import { type ReactElement, useEffect, useRef, useState } from 'react';

import { Composer } from './Composer';
import styles from './styles.module.css';
import { Transcript } from './Transcript';
import { useAsk } from './use-ask';

const EMPTY_STATE =
  'Ask a question in plain language. Answers come only from the published documentation, and every ' +
  'one cites the page it came from.';

export interface AskPanelProps {
  /** `page` fills its container; `panel` is the floating widget. */
  readonly variant: 'page' | 'panel';
  readonly autoFocus?: boolean;
}

/**
 * The conversation surface, shared by the floating widget and the `/ask` page.
 *
 * Announcements are deliberately not attached to the streaming text. A live region over a token
 * stream makes a screen reader read the answer one fragment at a time, which is unusable — so the
 * answer streams into an inert node and one status message is announced once it is finished.
 */
export function AskPanel({ variant, autoFocus = false }: AskPanelProps): ReactElement {
  const { turns, isAsking, ask, stop, clear } = useAsk();
  const [announcement, setAnnouncement] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const wasAsking = useRef(false);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });

    if (wasAsking.current && !isAsking) {
      const last = turns.at(-1);
      if (last?.kind === 'answer') {
        setAnnouncement(`Answer ready, with ${String(last.citations.length)} source(s).`);
      } else if (last?.kind === 'not-covered' || last?.kind === 'failed') {
        setAnnouncement(last.message);
      }
    }
    wasAsking.current = isAsking;
  }, [turns, isAsking]);

  return (
    <div className={variant === 'page' ? styles.pageBody : styles.panelBody}>
      <div className={styles.scroller} ref={scroller}>
        {turns.length === 0 ? (
          <p className={styles.empty}>{EMPTY_STATE}</p>
        ) : (
          <Transcript turns={turns} />
        )}
      </div>

      <div className={styles.status} role="status" aria-live="polite">
        {announcement}
      </div>

      <Composer
        isAsking={isAsking}
        hasTranscript={turns.length > 0}
        actions={{ ask, stop, clear }}
        autoFocus={autoFocus}
      />
    </div>
  );
}
