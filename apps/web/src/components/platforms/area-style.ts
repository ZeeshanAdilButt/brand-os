import { FileText, Layers, Mic, Newspaper, Rocket, Share2, Users, Video, type LucideIcon } from 'lucide-react';
import type { Area } from '@/lib/directory';

/** Category colour appears only on a small icon and a label, never on a card background. */
export const AREA_STYLE: Record<Area, { icon: LucideIcon; text: string }> = {
  blogs: { icon: FileText, text: 'text-category-blogs' },
  social: { icon: Share2, text: 'text-category-social' },
  communities: { icon: Users, text: 'text-category-communities' },
  video: { icon: Video, text: 'text-category-video' },
  conferences: { icon: Mic, text: 'text-category-conferences' },
  editorial: { icon: Newspaper, text: 'text-category-editorial' },
  launches: { icon: Rocket, text: 'text-category-launches' },
  aggregators: { icon: Layers, text: 'text-category-aggregators' },
};
