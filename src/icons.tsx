interface IconProps {
  size?: number;
}

export const IconPlay = ({ size = 28 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M8 5.5v13a1 1 0 0 0 1.53.85l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5Z" />
  </svg>
);

export const IconPause = ({ size = 28 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="6" y="5" width="4.5" height="14" rx="1.5" />
    <rect x="13.5" y="5" width="4.5" height="14" rx="1.5" />
  </svg>
);

export const IconNext = ({ size = 26 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M6 5.5v13a1 1 0 0 0 1.54.84l8-6.5a1 1 0 0 0 0-1.68l-8-6.5A1 1 0 0 0 6 5.5Z" />
    <rect x="16.5" y="5" width="2.6" height="14" rx="1.3" />
  </svg>
);

export const IconPrev = ({ size = 26 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M18 5.5v13a1 1 0 0 1-1.54.84l-8-6.5a1 1 0 0 1 0-1.68l8-6.5A1 1 0 0 1 18 5.5Z" />
    <rect x="4.9" y="5" width="2.6" height="14" rx="1.3" />
  </svg>
);

export const IconPlus = ({ size = 22 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 4a2 2 0 0 1 2 2v4h4a2 2 0 1 1 0 4h-4v4a2 2 0 1 1-4 0v-4H6a2 2 0 1 1 0-4h4V6a2 2 0 0 1 2-2Z" />
  </svg>
);

export const IconX = ({ size = 18 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 10.6 8.7 7.3a2 2 0 1 0-2.9 2.8l3.3 3.3-3.3 3.3a2 2 0 1 0 2.9 2.8l3.3-3.3 3.3 3.3a2 2 0 1 0 2.9-2.8L14.9 13.4l3.3-3.3a2 2 0 1 0-2.9-2.8L12 10.6Z" />
  </svg>
);

export const IconUp = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 5.2 4.6 12.6a2 2 0 1 0 2.8 2.8L12 10.8l4.6 4.6a2 2 0 1 0 2.8-2.8L12 5.2Z" />
  </svg>
);

export const IconDown = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 18.8 4.6 11.4a2 2 0 1 1 2.8-2.8L12 13.2l4.6-4.6a2 2 0 1 1 2.8 2.8L12 18.8Z" />
  </svg>
);

export const IconNote = ({ size = 20 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M9 4.5V15a3.5 3.5 0 1 1-2-3.16V6.4a1 1 0 0 1 .76-.97l9-2.25A1 1 0 0 1 18 4.15v8.35a3.5 3.5 0 1 1-2-3.16V7.75L11 9.13v7.37H9Z" />
  </svg>
);

export const IconSearch = ({ size = 22 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m15.5 15.5 5 5" />
  </svg>
);

export const IconTrash = ({ size = 18 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M9.5 3.5h5a1 1 0 0 1 1 1V6H20a1 1 0 1 1 0 2h-.6l-.8 11.2a2 2 0 0 1-2 1.85h-9.2a2 2 0 0 1-2-1.85L4.6 8H4a1 1 0 0 1 0-2h4.5V4.5a1 1 0 0 1 1-1Zm1.2 6.3a1 1 0 0 0-1 1v6.4a1 1 0 1 0 2 0v-6.4a1 1 0 0 0-1-1Zm2.6 0a1 1 0 0 0-1 1v6.4a1 1 0 1 0 2 0v-6.4a1 1 0 0 0-1-1Z" />
  </svg>
);

export const IconLoop = ({ size = 22 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M7 5h10a4 4 0 0 1 4 4v.5a1.2 1.2 0 0 1-2.4 0V9a1.6 1.6 0 0 0-1.6-1.6H7.2l1.9 1.9a1.2 1.2 0 0 1-1.7 1.7L4.3 7.9a1.2 1.2 0 0 1 0-1.7L7.4 3a1.2 1.2 0 0 1 1.7 1.7L7.3 6.6 7 5Z" />
    <path d="M17 19H7a4 4 0 0 1-4-4v-.5a1.2 1.2 0 0 1 2.4 0V15a1.6 1.6 0 0 0 1.6 1.6h9.8l-1.9-1.9a1.2 1.2 0 0 1 1.7-1.7l3.1 3.1a1.2 1.2 0 0 1 0 1.7L16.6 22a1.2 1.2 0 0 1-1.7-1.7l1.8-1.6-.1.3Z" />
  </svg>
);

export const IconGear = ({ size = 18 }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="3.4" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.86a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.08A1.7 1.7 0 0 0 10.11 3.04V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.88V9c.12.4.35.75.67 1.02.3.26.68.42 1.08.46H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z" />
  </svg>
);

export const IconBolt = ({ size = 18 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M13.5 2a1 1 0 0 1 .9 1.5L10.8 9h4.5a1 1 0 0 1 .8 1.6l-6.8 10A1 1 0 0 1 7.6 20l.4-6H4a1 1 0 0 1-.8-1.6l8.4-10A1 1 0 0 1 13.5 2Z" />
  </svg>
);

export const IconImport = ({ size = 18 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 15V4m0 11 4-4" />
    <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </svg>
);

export const IconEdit = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m16.5 3.9 3.6 3.6-11 11L4 19.5l1-5.1L16.5 3.9Z" />
    <path d="m14.5 6 3.5 3.5" />
  </svg>
);

export const IconLink = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" aria-hidden="true">
    <path d="M10 14a4.6 4.6 0 0 0 6.5.4l2.6-2.6a4.6 4.6 0 0 0-6.5-6.5L11 7" />
    <path d="M14 10a4.6 4.6 0 0 0-6.5-.4l-2.6 2.6a4.6 4.6 0 0 0 6.5 6.5L13 17" />
  </svg>
);

export const IconScan = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 11a8 8 0 1 0-2.3 6.3" />
    <path d="M20 5v6h-6" />
  </svg>
);

export const IconList = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" aria-hidden="true">
    <path d="M9 6h11M9 12h11M9 18h11" />
    <circle cx="4.5" cy="6" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="18" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);

export const IconChevron = ({ size = 10 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M9.2 4.6a1.6 1.6 0 0 1 2.3 0l7 7a1.6 1.6 0 0 1 0 2.3l-7 7a1.6 1.6 0 1 1-2.3-2.3L15.4 12 9.2 5.8a1.6 1.6 0 0 1 0-1.2Z" />
  </svg>
);

export const IconMore = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="12" cy="5" r="1.9" />
    <circle cx="12" cy="12" r="1.9" />
    <circle cx="12" cy="19" r="1.9" />
  </svg>
);

export const IconFolder = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.5 7.5v10a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2H12l-1.8-2.2a2 2 0 0 0-1.5-.8H5.5a2 2 0 0 0-2 2Z" />
  </svg>
);

export const IconWave = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="M3 12h2.2M7 7.5v9M10.5 4.5v15M14 8.5v7M17.5 6v12M21 10v4" />
  </svg>
);

export const IconTag = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.5 10.7V5a1.5 1.5 0 0 1 1.5-1.5h5.7a2 2 0 0 1 1.4.6l8 8a2 2 0 0 1 0 2.8l-5.1 5.1a2 2 0 0 1-2.8 0l-8-8a2 2 0 0 1-.7-1.3Z" />
    <circle cx="8.3" cy="8.3" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

export const LogoRadio = ({ size = 34 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
    <rect x="6" y="18" width="52" height="34" rx="9" fill="#2b3442" stroke="#4f8cff" strokeWidth="3" />
    <path d="M20 6 44 18" stroke="#4f8cff" strokeWidth="4" strokeLinecap="round" fill="none" />
    <circle cx="46" cy="14" r="4" fill="#22c55e" />
    <circle cx="22" cy="35" r="9" fill="#e6eaf0" opacity="0.9" />
    <circle cx="22" cy="35" r="3.5" fill="#2b3442" />
    <rect x="36" y="27" width="16" height="4" rx="2" fill="#e6eaf0" opacity="0.8" />
    <rect x="36" y="35" width="16" height="4" rx="2" fill="#e6eaf0" opacity="0.5" />
    <rect x="36" y="43" width="10" height="4" rx="2" fill="#e6eaf0" opacity="0.3" />
  </svg>
);

export const IconVinyl = ({ size = 150 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" className="vinyl">
    <defs>
      <linearGradient id="vinylGrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#334155" />
        <stop offset="100%" stopColor="#0f172a" />
      </linearGradient>
    </defs>
    <circle cx="50" cy="50" r="48" fill="url(#vinylGrad)" />
    <circle cx="50" cy="50" r="38" fill="none" stroke="#64748b" strokeWidth="1.2" opacity="0.55" />
    <circle cx="50" cy="50" r="30" fill="none" stroke="#64748b" strokeWidth="1" opacity="0.4" />
    <circle cx="50" cy="50" r="22" fill="#22c55e" />
    <circle cx="50" cy="50" r="17" fill="#f472b6" />
    <circle cx="50" cy="50" r="4" fill="#1e293b" />
  </svg>
);

export const IconSliders = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <rect x="2.5" y="2.5" width="19" height="19" rx="3" opacity="0.5" />
    <path d="M7 6v12M12 6v12M17 6v12" opacity="0.55" />
    <rect x="5" y="12" width="4" height="2.6" rx="0.8" fill="currentColor" stroke="none" />
    <rect x="10" y="8" width="4" height="2.6" rx="0.8" fill="currentColor" stroke="none" />
    <rect x="15" y="10.5" width="4" height="2.6" rx="0.8" fill="currentColor" stroke="none" />
  </svg>
);
