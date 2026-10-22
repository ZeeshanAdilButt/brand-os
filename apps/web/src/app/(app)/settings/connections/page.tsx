import { redirect } from 'next/navigation';

/** Accounts now live under Platforms, Integrations. This address keeps old links working. */
export default function ConnectionsRedirect() {
  redirect('/platforms/integrations');
}
