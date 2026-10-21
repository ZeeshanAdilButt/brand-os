import { handleSiteSettingsGet, handleSiteSettingsSave } from '@/server/http/publishing-handlers';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handleSiteSettingsGet(request);
}

export async function PUT(request: Request) {
  return handleSiteSettingsSave(request);
}
