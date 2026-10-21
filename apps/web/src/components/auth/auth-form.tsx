'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormNotice, Input } from '@/components/ui/field';

const MIN_PASSWORD = 10;

/**
 * Email and password form. It posts to the Better Auth endpoints over fetch so the same origin
 * check and rate limit apply as for any other client. On success the session cookie is already set.
 */
export function AuthForm({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const signUp = mode === 'sign-up';

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const data = new FormData(event.currentTarget);
    const email = String(data.get('email') ?? '').trim();
    const password = String(data.get('password') ?? '');
    const name = String(data.get('name') ?? '').trim();
    if (signUp && password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters for the password.`);
      return;
    }
    setPending(true);
    try {
      const res = await fetch(signUp ? '/api/auth/sign-up/email' : '/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signUp ? { email, password, name } : { email, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        if (res.status === 429) setError('Too many attempts. Wait a minute and try again.');
        else if (res.status === 401) setError('That email and password do not match.');
        else setError(body.message ?? 'Something went wrong. Try again.');
        return;
      }
      router.replace(signUp ? '/onboarding' : '/');
      router.refresh();
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      {signUp ? (
        <Field label="Name" htmlFor="name">
          <Input id="name" name="name" autoComplete="name" required maxLength={120} />
        </Field>
      ) : null}
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="email" required maxLength={254} />
      </Field>
      <Field
        label="Password"
        htmlFor="password"
        {...(signUp ? { hint: `At least ${MIN_PASSWORD} characters. A short phrase works well.` } : {})}
      >
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete={signUp ? 'new-password' : 'current-password'}
          required
          maxLength={128}
          {...(signUp ? { 'aria-describedby': 'password-hint' } : {})}
        />
      </Field>
      {error ? <FormNotice tone="error">{error}</FormNotice> : null}
      <Button type="submit" disabled={pending} size="lg">
        {pending ? 'One moment' : signUp ? 'Create account' : 'Sign in'}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        {signUp ? (
          <>
            Already have an account?{' '}
            <Link href="/sign-in" className="font-medium text-link underline-offset-4 hover:underline">
              Sign in
            </Link>
          </>
        ) : (
          <>
            New here?{' '}
            <Link href="/sign-up" className="font-medium text-link underline-offset-4 hover:underline">
              Create an account
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
