import { type ReactElement, type SyntheticEvent, useState } from 'react';

import styles from './styles.module.css';
import { type FeedbackStatus } from './types';

const MAX_REASON_LENGTH = 500;

export interface FeedbackControlProps {
  readonly status: FeedbackStatus;
  readonly onSubmit: (reason?: string) => void;
}

/**
 * The quiet "this did not help" control under an answer.
 *
 * Deliberately one-sided. There is no thumbs-up, because nobody clicks to say an answer worked and
 * a ratio built from that would be noise — the useful signal is the complaint, which is also the
 * only thing worth storing a reader's question for.
 *
 * The reason box appears only after the reader has said the answer was unhelpful, and stays
 * optional. Demanding an explanation up front is how you end up collecting nothing at all.
 */
export function FeedbackControl({ status, onSubmit }: FeedbackControlProps): ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [reason, setReason] = useState('');

  if (status === 'sent') {
    return (
      <p className={styles.feedbackDone} role="status">
        Thanks — we have recorded this gap.
      </p>
    );
  }

  if (!isOpen) {
    return (
      <div className={styles.feedback}>
        <button
          type="button"
          className={styles.feedbackButton}
          onClick={() => {
            setIsOpen(true);
          }}
        >
          This did not help
        </button>
      </div>
    );
  }

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    onSubmit(reason);
  };

  return (
    <form className={styles.feedback} onSubmit={submit}>
      <label className={styles.feedbackLabel} htmlFor="ask-feedback-reason">
        What were you looking for? (optional)
      </label>
      <div className={styles.feedbackRow}>
        <input
          id="ask-feedback-reason"
          className={styles.feedbackReason}
          type="text"
          maxLength={MAX_REASON_LENGTH}
          value={reason}
          disabled={status === 'sending'}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
        <button type="submit" className={styles.feedbackButton} disabled={status === 'sending'}>
          {status === 'sending' ? 'Sending…' : 'Send'}
        </button>
      </div>
      {status === 'failed' && (
        <p className={styles.feedbackFailed} role="status">
          That did not reach us. Try again in a moment.
        </p>
      )}
    </form>
  );
}
