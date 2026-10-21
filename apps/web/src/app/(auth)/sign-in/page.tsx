import type { Metadata } from 'next';
import { AuthForm } from '@/components/auth/auth-form';

export const metadata: Metadata = { title: 'Sign in' };

export default function SignInPage() {
  return (
    <>
      <h1 className="mb-1 font-serif text-2xl font-semibold">Sign in</h1>
      <p className="mb-6 text-sm text-muted-foreground">Welcome back. Your knowledge and drafts are private to your account.</p>
      <AuthForm mode="sign-in" />
    </>
  );
}
