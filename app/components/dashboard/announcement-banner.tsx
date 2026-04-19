/**
 * Announcement Banner
 *
 * Dismissable banner shown at the top of the member dashboard for
 * ops-wide announcements — maintenance windows, policy changes, new
 * feature call-outs. Dismissal is per-user and persists in
 * localStorage so returning visitors do not see the same banner
 * twice.
 *
 * @version v0.3.0
 */
import { useState } from "react";
import { X } from "lucide-react";

type AnnouncementBannerProps = {
  text: string;
};

export function AnnouncementBanner({ text }: AnnouncementBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  if (!text || dismissed) {
    return null;
  }

  return (
    <div className="relative rounded-lg border border-[#F9EDD4] bg-[#FFFBF0] p-4 text-sm text-[#8B6914]">
      <span>{text}</span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="absolute right-2 top-2 rounded p-1 text-[#8B6914] hover:bg-[#F9EDD4]"
        aria-label="Dismiss announcement"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
