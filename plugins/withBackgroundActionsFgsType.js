const { withAndroidManifest } = require('@expo/config-plugins');

/**
 * react-native-background-actions ships its <service> with no
 * android:foregroundServiceType. Android 14+ (API 34) requires one, and for a
 * network upload/transcription pipeline the sanctioned type is "dataSync"
 * (developer.android.com/develop/background-work/services/fgs/service-types).
 *
 * That <service> lives in the LIBRARY's manifest, which the Gradle manifest
 * merger folds in at build time — so it is not present in the app manifest that
 * `expo prebuild` writes, and can't be edited directly. Instead we add a
 * matching <service> node in the app manifest with tools:node="merge"; the
 * merger combines it with the library's declaration and adds the attribute.
 */
const SERVICE_NAME = 'com.asterinet.react.bgactions.RNBackgroundActionsTask';

module.exports = function withBackgroundActionsFgsType(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;

    // tools:node needs the tools namespace declared on <manifest>.
    manifest.$ = manifest.$ || {};
    if (!manifest.$['xmlns:tools']) {
      manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    }

    const application = manifest.application && manifest.application[0];
    if (!application) return cfg;
    application.service = application.service || [];

    const existing = application.service.find(
      (s) => s.$ && s.$['android:name'] === SERVICE_NAME
    );
    if (existing) {
      existing.$['android:foregroundServiceType'] = 'dataSync';
      existing.$['tools:node'] = 'merge';
    } else {
      application.service.push({
        $: {
          'android:name': SERVICE_NAME,
          'android:foregroundServiceType': 'dataSync',
          'tools:node': 'merge',
        },
      });
    }
    return cfg;
  });
};
