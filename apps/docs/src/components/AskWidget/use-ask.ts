import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { askTheDocs } from './ask-client';
import { type ConversationMessage, type Turn } from './types';

/**
 * How many prior turns travel with each question.
 *
 * This is a cost control as much as a limit. History is re-sent in full every turn, so the input
 * tokens billed per question grow with the conversation unless something bounds it. The gateway
 * enforces the same cap and rejects anything longer; trimming here means a long conversation
 * degrades quietly instead of failing.
 */
const MAX_HISTORY_MESSAGES = 10;

type Answer = Extract<Turn, { kind: 'answer' }>;

export interface AskController {
  readonly turns: readonly Turn[];
  readonly isAsking: boolean;
  readonly ask: (question: string) => void;
  readonly stop: () => void;
  readonly clear: () => void;
}

interface AskDeps {
  readonly setTurns: Dispatch<SetStateAction<readonly Turn[]>>;
  readonly setIsAsking: Dispatch<SetStateAction<boolean>>;
  readonly controller: RefObject<AbortController | null>;
}

let sequence = 0;

function nextId(): string {
  sequence += 1;
  return `turn-${String(sequence)}`;
}

/** Only completed answers become history; a failed or declined turn is not part of the exchange. */
function toHistory(turns: readonly Turn[]): ConversationMessage[] {
  const history: ConversationMessage[] = [];

  for (const [index, turn] of turns.entries()) {
    // `at` rather than an index, because it is typed to admit undefined at the end of the list.
    const next = turns.at(index + 1);
    if (turn.kind !== 'question' || next?.kind !== 'answer' || next.status !== 'complete') {
      continue;
    }
    history.push({ role: 'user', content: turn.text });
    history.push({ role: 'assistant', content: next.text });
  }

  return history.slice(-MAX_HISTORY_MESSAGES);
}

/** Every update targets the answer being streamed, which is always the last turn. */
function withLastAnswer(turns: readonly Turn[], update: (answer: Answer) => Turn): readonly Turn[] {
  const last = turns.at(-1);
  return last?.kind === 'answer' ? [...turns.slice(0, -1), update(last)] : turns;
}

const markComplete = (answer: Answer): Turn =>
  answer.status === 'streaming' ? { ...answer, status: 'complete' } : answer;

function startAsk(question: string, deps: AskDeps): void {
  const abort = new AbortController();
  deps.controller.current = abort;
  deps.setIsAsking(true);

  const answerId = nextId();
  let history: readonly ConversationMessage[] = [];

  deps.setTurns((current) => {
    history = toHistory(current);
    return [
      ...current,
      { kind: 'question', id: nextId(), text: question },
      { kind: 'answer', id: answerId, text: '', citations: [], status: 'streaming' },
    ];
  });

  const settle = (turn: Turn): void => {
    deps.setTurns((current) => [...current.slice(0, -1), turn]);
  };

  void askTheDocs({
    question,
    history,
    signal: abort.signal,
    handlers: {
      onCitations: (citations) => {
        deps.setTurns((current) => withLastAnswer(current, (answer) => ({ ...answer, citations })));
      },
      onToken: (text) => {
        deps.setTurns((current) =>
          withLastAnswer(current, (answer) => ({ ...answer, text: answer.text + text })),
        );
      },
      onNotCovered: (message) => {
        settle({ kind: 'not-covered', id: answerId, message });
      },
      onFailure: (message) => {
        settle({ kind: 'failed', id: answerId, message });
      },
    },
  }).finally(() => {
    if (abort.signal.aborted) {
      return;
    }
    deps.controller.current = null;
    deps.setIsAsking(false);
    deps.setTurns((current) => withLastAnswer(current, markComplete));
  });
}

/**
 * Drives one conversation with the documentation.
 *
 * State lives here and nowhere else — there is no server session. The conversation is posted in
 * full with each question, which matches requirements.md's "no cross-session memory" non-goal and
 * means a reader's questions never have to be retained anywhere to make the next turn work.
 *
 * @returns The transcript, whether a question is in flight, and the actions to drive it.
 */
export function useAsk(): AskController {
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const [isAsking, setIsAsking] = useState(false);
  const controller = useRef<AbortController | null>(null);

  // A reader who navigates away mid-answer should stop the model, not leave it writing into a
  // component that no longer exists.
  useEffect(() => {
    return () => {
      controller.current?.abort();
    };
  }, []);

  const stop = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setIsAsking(false);
    setTurns((current) => withLastAnswer(current, markComplete));
  }, []);

  const clear = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setIsAsking(false);
    setTurns([]);
  }, []);

  const ask = useCallback((question: string) => {
    const trimmed = question.trim();
    if (trimmed === '') {
      return;
    }
    controller.current?.abort();
    startAsk(trimmed, { setTurns, setIsAsking, controller });
  }, []);

  return { turns, isAsking, ask, stop, clear };
}
