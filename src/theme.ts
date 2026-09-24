export const colors = {
  bg: '#0b0f16',
  surface: '#121821',
  surfaceAlt: '#1a2230',
  border: '#2a3443',
  text: '#f5f7fa',
  textDim: '#a4adbc',
  textFaint: '#788396',
  accent: '#2f7df6',
  accentPressed: '#2369d8',
  accentSoft: '#132a4b',
  danger: '#ef6257',
  dangerSoft: '#321d20',
  success: '#3ecf8e',
  link: '#78aaff',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 };

export const radius = { sm: 8, md: 14, lg: 20, pill: 999 };

export const bottomTabStyle = {
  backgroundColor: colors.surface,
  borderTopColor: colors.border,
  borderTopWidth: 1,
  height: 82,
  paddingTop: 10,
  paddingBottom: 12,
} as const;

export const text = {
  h1: { fontSize: 28, lineHeight: 34, fontWeight: '700' as const, color: colors.text },
  h2: { fontSize: 17, lineHeight: 23, fontWeight: '700' as const, color: colors.text },
  body: { fontSize: 15, lineHeight: 24, color: '#d8dde7' },
  label: { fontSize: 14, fontWeight: '600' as const, color: colors.text },
  meta: { fontSize: 14, lineHeight: 21, color: colors.textDim },
  tiny: { fontSize: 12, lineHeight: 18, color: colors.textFaint },
};
