// Static content: muscle sites, M40 LED colour patterns, and the 15-step protocol.

export const SITES = [
  {
    key: 'SCM',
    short: 'SCM',
    label: 'Sternocleidomastoid (SCM)',
    placement: [
      'Ask the person to turn the head to the opposite side; the SCM stands out as a band from behind the ear to the top of the sternum.',
      'Place the M40 on the muscle belly, about halfway between the mastoid process and the sternal notch.',
      'Align the two electrodes along the fibres (diagonal, ear → sternum).',
      'Keep clear of the carotid pulse and the external jugular vein.',
    ],
    mvc: 'Seated. Resisted head flexion with slight rotation to the opposite side (hand on forehead), build up over 1–2 s, hold 3–5 s.',
  },
  {
    key: 'UT',
    short: 'TRP upper',
    label: 'Upper trapezius (TRP upper)',
    placement: [
      'Find the C7 spinous process (most prominent at the base of the neck) and the acromion.',
      'Place the M40 at the midpoint of the line C7 → acromion (SENIAM).',
      'Align the electrodes along that line, i.e. along the fibres.',
    ],
    mvc: 'Seated. Resisted shoulder elevation (shrug) against manual resistance on the acromion, hold 3–5 s.',
  },
  {
    key: 'TI',
    short: 'TRP ins',
    label: 'Trapezius, upper insertion (TRP ins)',
    placement: [
      'Upper (cranial) attachment of the trapezius, just below the occiput: feel the external occipital protuberance and the superior nuchal line.',
      'Place the M40 just below the superior nuchal line, about 1–2 cm lateral of the midline, on the side being measured.',
      'Align the electrodes along the descending fibres (roughly vertical here).',
      'Keep it clear of the hairline, or part and clean the hair, so the electrodes stick. Keep clear of the SCM sensor.',
    ],
    mvc: 'Seated. Resisted head extension (hand on the back of the head), build up over 1–2 s, hold 3–5 s.',
  },
  {
    key: 'OTHER',
    short: 'Other',
    label: 'Other / custom',
    placement: ['Free placement. Align the electrodes along the muscle fibres.'],
    mvc: 'Use a manoeuvre appropriate for the muscle.',
  },
];

export const siteByKey = (k) => SITES.find((s) => s.key === k) || SITES[SITES.length - 1];

// M40 product sheet: Digital characteristic 0x2A56, value 1–24 selects the LED colour pattern.
// 17–24 switch the LED off after connecting, so only 1–16 are offered.
const C = { Blue: '#2f6fff', Green: '#20c040', Red: '#ff3030', White: '#ffffff' };
export const LED_PATTERNS = [];
['Blue', 'Green', 'Red', 'White'].forEach((a, i) =>
  ['Blue', 'Green', 'Red', 'White'].forEach((b, j) =>
    LED_PATTERNS.push({ id: i * 4 + j + 1, label: `${a} / ${b}`, c1: C[a], c2: C[b] })
  )
);
// Default LED per sensor slot: solid colours first, they are easiest to tell apart on the body.
export const LED_DEFAULT_ORDER = [1, 6, 11, 16, 3, 8, 9, 14];

export const STEPS = [
  {
    n: 1, title: 'Saccades, horizontal', reps: 20, head: false,
    cue: 'Look quickly from one target to the other and back. Keep your head still. Only your eyes move.',
    setup: 'Two targets at eye level, side by side.',
  },
  {
    n: 2, title: 'Saccades, vertical', reps: 20, head: false,
    cue: 'Look quickly between the upper and the lower target. Keep your head still.',
    setup: 'Two targets, one above the other.',
  },
  {
    n: 3, title: 'Saccades, diagonal (right-up)', reps: 20, head: false,
    cue: 'Look quickly between the two targets on the diagonal, up to the right and down to the left. Keep your head still.',
    setup: 'Two targets on a diagonal, upper one to the right.',
  },
  {
    n: 4, title: 'Saccades, diagonal (left-up)', reps: 20, head: false,
    cue: 'Look quickly between the two targets on the diagonal, up to the left and down to the right. Keep your head still.',
    setup: 'Two targets on a diagonal, upper one to the left.',
  },
  {
    n: 5, title: 'Object following, horizontal', reps: 20, head: false,
    cue: 'Follow the words on the card with your eyes as it moves side to side. Keep your head still.',
    setup: 'Target with printed words, held 25–30 cm from the eyes, moved horizontally.',
  },
  {
    n: 6, title: 'Object following, vertical', reps: 20, head: false,
    cue: 'Follow the words on the card with your eyes as it moves up and down. Keep your head still.',
    setup: 'Same target, 25–30 cm from the eyes, moved vertically.',
  },
  {
    n: 7, title: 'Target focus, continuous', reps: 15, head: true,
    cue: 'Turn your head to look at the left, centre and right objects in turn, without stopping.',
    setup: 'Three objects at eye level: left, centre, right.',
  },
  {
    n: 8, title: 'Target focus, with stops', reps: 15, head: true,
    cue: 'Turn your head to look at the left, centre and right objects in turn. Stop briefly at each one.',
    setup: 'Same three objects as step 7.',
  },
  {
    n: 9, title: 'Horizontal ballistics', reps: 20, head: true, interRepRest: 3,
    cue: 'Turn your head quickly to the right, to the left and back to centre. Then rest for 3 seconds.',
    setup: 'A 3 s rest countdown appears after each rep you count.',
  },
  {
    n: 10, title: 'Fast head circles, clockwise, eyes open', reps: 20, head: true,
    cue: 'Make quick circles with your head, clockwise, eyes open.',
    setup: 'Seated, shoulders relaxed.',
  },
  {
    n: 11, title: 'Fast head circles, clockwise, eyes closed', reps: 20, head: true,
    cue: 'Close your eyes. Make quick circles with your head, clockwise.',
    setup: 'Eyes closed: stay within reach for safety.',
  },
  {
    n: 12, title: 'Fast head circles, counter-clockwise, eyes open', reps: 20, head: true,
    cue: 'Make quick circles with your head, counter-clockwise, eyes open.',
    setup: 'Seated, shoulders relaxed.',
  },
  {
    n: 13, title: 'Fast head circles, counter-clockwise, eyes closed', reps: 20, head: true,
    cue: 'Close your eyes. Make quick circles with your head, counter-clockwise.',
    setup: 'Eyes closed: stay within reach for safety.',
  },
  {
    n: 14, title: 'Rotational focus', reps: 20, head: true,
    cue: 'Keep your eyes on your index finger and turn your head left and right.',
    setup: 'Index finger held about 20 cm in front of the nose. Gaze fixed on the finger.',
  },
  {
    n: 15, title: 'Rotational focus (second set)', reps: 20, head: true,
    cue: 'Same again: eyes on your finger, turn your head left and right.',
    setup: 'Second set of step 14.',
  },
];
