/** Result of a form submitted through a server action. */
export interface FormState {
  status: 'idle' | 'error' | 'saved';
  message?: string;
  fields?: Record<string, string>;
}

export const IDLE: FormState = { status: 'idle' };
