import {
  type KeyboardEvent,
  type ReactElement,
  type SyntheticEvent,
  useEffect,
  useRef,
  useState,
} from 'react';

import styles from './styles.module.css';

const PLACEHOLDER = 'Ask about the documentation…';

export interface ComposerProps {
  readonly isAsking: boolean;
  readonly hasTranscript: boolean;
  readonly actions: {
    readonly ask: (question: string) => void;
    readonly stop: () => void;
    readonly clear: () => void;
  };
  /** Focus on mount. The widget does; the page leaves the reader in control of where they are. */
  readonly autoFocus?: boolean;
}

/**
 * The question box and its controls.
 *
 * Enter sends and Shift+Enter inserts a newline — the convention readers already have from every
 * other chat box, and the reason this is a textarea rather than an input.
 *
 * The label is present and visually hidden rather than absent: a placeholder disappears as soon
 * as typing starts, so it is not a label.
 */
export function Composer({
  isAsking,
  hasTranscript,
  actions,
  autoFocus = false,
}: ComposerProps): ReactElement {
  const [draft, setDraft] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);

  // Focused through a ref rather than the `autofocus` attribute, which fires on page load and
  // would drag a reader to the widget before they had opened it.
  useEffect(() => {
    if (autoFocus) {
      field.current?.focus();
    }
  }, [autoFocus]);

  function send(): void {
    actions.ask(draft);
    setDraft('');
  }

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    send();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  return (
    <form className={styles.composer} onSubmit={submit}>
      <label className={styles.srOnly} htmlFor="ask-composer">
        Your question
      </label>
      <textarea
        id="ask-composer"
        ref={field}
        className={styles.input}
        value={draft}
        rows={2}
        placeholder={PLACEHOLDER}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <div className={styles.actions}>
        {hasTranscript && (
          <button type="button" className={styles.secondary} onClick={actions.clear}>
            Clear
          </button>
        )}
        {isAsking ? (
          <button type="button" className={styles.secondary} onClick={actions.stop}>
            Stop
          </button>
        ) : (
          <button type="submit" className={styles.primary} disabled={draft.trim() === ''}>
            Ask
          </button>
        )}
      </div>
    </form>
  );
}
