# Design QA

- Source visual truth: `design/reference-option-1.png`
- Implementation screenshots: `design/implementation-v3.5.9-record.jpg` and `design/implementation-v3.5.9-history.jpg`
- Combined comparison: `design/qa-v3.5.9-record-comparison.jpg`
- Target viewport: 390 × 844 CSS px, portrait
- Source pixels: 853 × 1844 px
- Implementation pixels: 1080 × 2392 px, including Android system bars
- Implementation CSS size / device density: not reported by the capture device
- Density normalization: the implementation was scaled to 833 × 1844 px and placed beside the 853 × 1844 source in the combined comparison. Android status/navigation chrome remains visible and was excluded from app-content judgments.
- State: New recording / idle / dark theme

## Full-view comparison evidence

The v3.5.9 device capture preserves the selected direction: graphite background, cobalt recorder, concentric rings, centered idle copy, full-width actions, and three-item bottom navigation. Two material differences are visible: every screen title is collapsed into thin fragments, and the idle composition ends far above the bottom navigation instead of maintaining the source's tighter lower spacing.

## Focused-region comparison evidence

The combined comparison makes the header, recorder hero, action stack, and navigation readable at the same normalized height. It confirms that the icon family, colors, ring treatment, button widths, and tab states are faithful enough, while title rendering and vertical rhythm require correction.

## Findings

- [P1] Screen titles collapse into fragments
  - Location: `App.tsx` navigator header options
  - Evidence: both Record and History device captures show only thin white fragments where “New recording” and “History” should appear; the source shows a clear left-aligned title.
  - Impact: users lose screen identity and the interface appears broken.
  - Fix applied in v3.5.10: removed the custom header height and absolute title-container offset so React Navigation owns safe-area and title measurement.

- [P2] Idle composition is top-packed on the capture device
  - Location: `src/screens/RecordScreen.tsx` idle container
  - Evidence: v3.5.9 leaves a large empty region between Import audio and the tabs; the source keeps roughly one compact navigation-width gap.
  - Impact: the primary task feels detached from the thumb zone and the screen loses the intended balanced rhythm.
  - Fix applied in v3.5.10: bottom-anchored the composition with a 64dp content inset while retaining scrolling for shorter devices.

- [P2] Recorder center and idle type are visually undersized
  - Location: `src/screens/RecordScreen.tsx` recorder and idle text styles
  - Evidence: the v3.5.9 center orb, title, supporting copy, and action labels are smaller than their source counterparts in the normalized comparison.
  - Impact: the primary action has less visual authority than the selected design.
  - Fix applied in v3.5.10: increased inner-ring/orb proportions, microphone size, idle heading/body sizes, and action heights while preserving the outer ring footprint.

## Required fidelity surfaces

- Fonts and typography: system-font rendering is crisp and hierarchy is clear below the broken header; v3.5.10 increases idle display and action sizes. Post-fix wrapping remains to be captured.
- Spacing and layout rhythm: 24dp horizontal margins, full-width actions, radii, and bottom navigation match the direction. v3.5.10 corrects the overly large lower void; post-fix evidence is pending.
- Colors and visual tokens: the graphite, cobalt, cool-gray, border, and active-state colors render consistently across Record and History with readable contrast.
- Image and icon fidelity: no raster artwork is required. Material Symbols render cleanly for microphone, upload, history, settings, and navigation; no emoji or placeholder assets remain.
- Copy and content: the idle copy matches the source. History data is realistic, multilingual text renders correctly, and truncation is consistent.

## Additional screen audit

1. History — healthy with refinements applied in v3.5.11. The supplied capture showed readable multilingual content and clear metadata, but rows were visually heavy and lacked an explicit open affordance. Rows now use lighter borders, tighter radii/rhythm, and a native chevron while retaining every tag and action.
2. Settings — implementation updated in v3.5.11; visual capture pending. Repeated card containers were flattened into divided sections, native section icons were added, API-key blocks remain clearly grouped, and test/add/save controls now use larger touch targets.

## Comparison history

- Iteration 1 — v3.5.9 capture: found the P1 header-title collapse and P2 vertical/scale drift documented above.
- Fixes: restored default React Navigation header measurement; bottom-anchored the idle layout; increased recorder-center, typography, and action proportions.
- Static post-fix evidence: TypeScript passed and the v3.5.10 native release APK built successfully.
- Cross-screen refinement: v3.5.11 extends the selected design system to History and Settings; TypeScript and the native release build pass.
- Navigation refinement: v3.5.12 gives the shared bottom bar its own surface, a stronger divider, larger icons and labels, and more vertical clearance so the active indicator no longer crowds Android's gesture area. The bar also hides when the keyboard opens.
- Visual post-fix evidence: pending v3.5.12 captures from the same device; the report remains blocked until that comparison is completed.

## Implementation checklist

1. Install `VoiceToText-v3.5.12.apk` on the same Android device.
2. Capture Record, History, and the top of Settings; confirm all three titles are visible.
3. Add the new frames to same-height comparisons.
4. Pass only if the recorded P1/P2 issues are visibly resolved and Settings remains readable.

## Follow-up polish

- Confirm the taller v3.5.12 navigation bar keeps the active indicator comfortably above the gesture area on the capture device.
- History cards are visually sound; a future polish pass could reduce card radius slightly if a denser list is preferred.

final result: blocked
