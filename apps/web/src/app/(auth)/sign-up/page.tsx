import type { Metadata } from 'next';
import { AuthForm } from '@/components/auth/auth-form';

export const metadata: Metadata = { title: 'Create account' };

export default function SignUpPage() {
  return (
    <>
      <h1 className="mb-1 font-serif text-2xl font-semibold">Create your account</h1>
      <p className="mb-6 text-sm text-muted-foreground">An email and a password. No third-party sign-in, no AI key needed.</p>
      <AuthForm mode="sign-up" />
    </>
  );
}
