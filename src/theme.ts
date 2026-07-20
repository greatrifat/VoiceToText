export const colors = {
  bg: '#0d0f16',
  surface: '#171a24',
  surfaceAlt: '#212533',
  border: '#2b3042',
  text: '#f4f6fa',
  textDim: '#8e97ad',
  textFaint: '#5c657b',
  accent: '#4d7cfe',
  accentSoft: '#1d2947',
  danger: '#f0574a',
  dangerSoft: '#2e1a1c',
  success: '#3ecf8e',
  link: '#7aa2ff',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

export const radius = { sm: 8, md: 12, lg: 16, pill: 999 };

export const text = {
  h1: { fontSize: 22, fontWeight: '700' as const, color: colors.text },
  h2: { fontSize: 16, fontWeight: '700' as const, color: colors.text },
  body: { fontSize: 15, lineHeight: 23, color: '#d5dae6' },
  label: { fontSize: 14, fontWeight: '600' as const, color: colors.text },
  meta: { fontSize: 13, color: colors.textDim },
  tiny: { fontSize: 12, color: colors.textFaint },
};
