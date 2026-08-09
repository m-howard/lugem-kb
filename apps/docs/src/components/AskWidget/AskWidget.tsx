import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';

import { AskPanel } from './AskPanel';
import styles from './styles.module.css';

const PANEL_ID = 'lugem-ask-panel';

/**
 * The floating launcher and the panel it opens, available on every documentation page.
 *
 * Mounted from `src/theme/Root.tsx`, which sits above the theme layout and is not remounted by
 * client-side navigation — so following a citation keeps the conversation rather than discarding
 * it, which is the whole reason the launcher lives there and not in a page component.
 *
 * The panel is `aria-modal="false"`: it sits beside the page rather than blocking it, so there is
 * no focus trap. Escape closes it and returns focus to the launcher, which is the round trip a
 * keyboard user needs and the easiest one to get wrong.
 */
export function AskWidget(): ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setIsOpen(false);
    launcher.current?.focus();
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        close();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, close]);

  return (
    <>
      <button
        ref={launcher}
        type="button"
        className={styles.launcher}
        aria-expanded={isOpen}
        aria-controls={PANEL_ID}
        onClick={() => {
          setIsOpen((open) => !open);
        }}
      >
        {isOpen ? 'Close' : 'Ask the docs'}
      </button>

      {isOpen && (
        <section
          id={PANEL_ID}
          className={styles.panel}
          role="dialog"
          aria-modal="false"
          aria-label="Ask the documentation"
        >
          <header className={styles.panelHeader}>
            <h2 className={styles.panelTitle}>Ask the documentation</h2>
            <button type="button" className={styles.close} onClick={close} aria-label="Close">
              ×
            </button>
          </header>
          <AskPanel variant="panel" autoFocus />
        </section>
      )}
    </>
  );
}
