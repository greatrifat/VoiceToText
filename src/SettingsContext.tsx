import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { EMPTY_SETTINGS, loadSettings, saveSettings, type Settings } from './settings';

type SettingsContextValue = {
  settings: Settings;
  ready: boolean;
  update: (next: Settings) => Promise<void>;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

/** Keeps the keystore read off the render path so every screen sees one copy. */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    loadSettings()
      .then(setSettings)
      .finally(() => setReady(true));
  }, []);

  async function update(next: Settings) {
    await saveSettings(next);
    setSettings(next);
  }

  return (
    <SettingsContext.Provider value={{ settings, ready, update }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (!value) {
    throw new Error('useSettings must be used inside a SettingsProvider');
  }
  return value;
}
