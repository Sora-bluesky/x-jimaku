import {
  describe,
  expect,
  it,
} from "vitest";
import {
  resolveSilentInputHint,
  type SilentHintTapState,
  type SilentHintVideoState,
  type SilentInputHintState,
  type SilentInputHintVariant,
} from "./silent-hint";

const TAP_STATES:
  readonly SilentHintTapState[] = [
    "missing",
    "starting",
    "suspended",
    "running",
    "stopping",
    "closed",
  ];

const VIDEO_STATES:
  readonly SilentHintVideoState[] = [
    "missing",
    "playing",
    "paused",
    "ended",
  ];

function expectedVariant(
  state: SilentInputHintState,
): SilentInputHintVariant | null {
  if (!state.showHint || !state.visible) {
    return null;
  }

  if (
    state.video === "paused" ||
    state.video === "ended"
  ) {
    return "paused";
  }

  if (
    state.video === "playing" &&
    state.tap === "suspended"
  ) {
    return "gesture";
  }

  return "unknown";
}

describe(
  "resolveSilentInputHint",
  () => {
    const cases: SilentInputHintState[] =
      [];

    for (
      const showHint of [false, true]
    ) {
      for (
        const visible of [false, true]
      ) {
        for (const tap of TAP_STATES) {
          for (
            const video of VIDEO_STATES
          ) {
            cases.push({
              showHint,
              visible,
              tap,
              video,
            });
          }
        }
      }
    }

    it.each(cases)(
      "resolves hint=$showHint visible=$visible tap=$tap video=$video",
      (state) => {
        expect(
          resolveSilentInputHint(state),
        ).toBe(expectedVariant(state));
      },
    );

    it(
      "re-evaluates a hint that arrives before the tap",
      () => {
        const initial: SilentInputHintState = {
          showHint: true,
          visible: true,
          tap: "starting",
          video: "playing",
        };

        expect(
          resolveSilentInputHint(initial),
        ).toBe("unknown");

        expect(
          resolveSilentInputHint({
            ...initial,
            tap: "suspended",
          }),
        ).toBe("gesture");
      },
    );

    it(
      "re-evaluates after the tap is replaced",
      () => {
        const suspended:
          SilentInputHintState = {
            showHint: true,
            visible: true,
            tap: "suspended",
            video: "playing",
          };

        expect(
          resolveSilentInputHint(suspended),
        ).toBe("gesture");

        expect(
          resolveSilentInputHint({
            ...suspended,
            tap: "running",
          }),
        ).toBe("unknown");
      },
    );

    it(
      "prioritizes paused video over a suspended tap",
      () => {
        expect(
          resolveSilentInputHint({
            showHint: true,
            visible: true,
            tap: "suspended",
            video: "paused",
          }),
        ).toBe("paused");
      },
    );

    it(
      "holds a hidden-tab hint and restores it when visible",
      () => {
        const hidden: SilentInputHintState = {
          showHint: true,
          visible: false,
          tap: "suspended",
          video: "playing",
        };

        expect(
          resolveSilentInputHint(hidden),
        ).toBeNull();

        expect(
          resolveSilentInputHint({
            ...hidden,
            visible: true,
          }),
        ).toBe("gesture");
      },
    );

    it(
      "does not revive a cleared hint after a late tap event",
      () => {
        expect(
          resolveSilentInputHint({
            showHint: false,
            visible: true,
            tap: "suspended",
            video: "playing",
          }),
        ).toBeNull();
      },
    );
  },
);
