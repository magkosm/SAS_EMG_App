# M40 Neck EMG Logger

A browser app for the SAS rehab protocol. It connects several **ANR M40 Muscle Sense** sensors over Bluetooth, shows their EMG live, guides you through the 15-step protocol and records the Mac camera, all on one clock.

## Start

Double-click **`start.command`**. It serves this folder on `http://localhost:8040` and opens Chrome.
Or from a terminal:

```bash
python3 serve.py 8040
```

Then open http://localhost:8040 in **Chrome or Edge**. Safari has no Web Bluetooth.
The first time, macOS asks to let Chrome use Bluetooth and the camera. Allow both (System Settings → Privacy & Security).

## Phones, tablets and browsers

| Device / browser | Record (Bluetooth + camera) | Replay & Analysis |
|---|---|---|
| Mac / Windows / Linux: Chrome or Edge | ✅ full, incl. saving straight to a folder | ✅ |
| Android: Chrome | ✅ should work: Web Bluetooth and camera are supported. Files are downloaded at the end (Android has no folder picker). Untested with real M40s. | ✅ pick the session files with "Select files…" |
| iPhone / iPad: Safari, Chrome, any browser | ❌ Apple allows no Web Bluetooth in any iOS browser | ✅ pick the files from the Files app |
| iPhone / iPad: Bluefy (third-party browser with Web Bluetooth) | ⚠️ possibly; untested | ✅ |
| Safari or Firefox on a computer | ❌ no Web Bluetooth | ✅ |

The layout adapts to phone width, but recording on a phone is cramped. A tablet in landscape is the better mobile option. Bluetooth and the camera need https (GitHub Pages) or localhost.

## Workflow

1. **Sensors**
   - Turn on each M40. Its LED pulses like a heartbeat while it waits to pair.
   - Press **+ Add M40 sensor**, pick the sensor in Chrome's list and repeat for each one.
   - Give each sensor a name, a muscle (SCM / TRP upper / TRP ins) and a side.
   - The app sets each sensor's LED to its own colour pattern. **Identify** flashes one sensor red/white.
   - Names and placements are remembered per sensor.
   - Turn the camera on and choose a save folder.
2. **Calibrate**
   - **Rest baseline** (10–30 s, relaxed) sets the rest level and the activity threshold (rest + 3 SD, the dashed line on the charts).
   - **MVC** is optional. Only use it when it is clinically appropriate.
3. **Start session** (top right). This starts the video recording and the data logging.
4. **Protocol**
   - Each step shows the cue to read to the patient, the setup and the rep target.
   - `Enter` starts or finishes a step. `Space` adds a rep, `⌫` removes one, and `←`/`→` change the step.
   - Step 9 shows a 3 s rest countdown after each rep.
   - There is an optional pacing metronome and a rest timer between steps.
   - After each step you can add a symptom rating (0–10) and a note.
   - **Redo step N** runs a step again. The older attempt is kept in the files but marked superseded.
5. **Stop & save**. Then open **Results** for a per-step heatmap (mean, peak or % active per sensor) and the files.

## Replay a session

Switch to **▶ Replay** in the top bar, or press **▶ Replay this session** in the Results tab after you stop. The second way loads the session you just recorded straight away. Recording keeps running in the background if you switch modes mid-session.

- **Opening a session:**
  - **Open folder…** with a session folder opens that session.
  - **Open folder…** with your save folder lists every session in it. Once you have chosen a save folder in Record mode, Replay offers its sessions directly.
  - **Select files…** or drag and drop work with all files of one session. Downloaded copies with the session-ID prefix work too.
- **Video and EMG play together.** A strip per sensor follows a playhead centred in a 10 s to 3 min window. The tiles show each sensor's value at the playhead and the step mean.
- **Markers:**
  - step bands, numbered ticks for every counted rep, and shaded calibration windows
  - red lines where a sensor lost signal
  - superseded attempts, faded
  - comments as blue flags
- **Comments:**
  - The **Comments** list shows the notes and symptom ratings you entered during the session, at the moment you entered them, plus the session note.
  - To add a comment, pause, press `C`, type and press Enter. The comment is pinned to the playhead time.
  - Replay comments are saved as `comments.csv` (`t_s, video_t_s, step, text, created`) in the session folder and loaded again next time.
  - When the session came from loose files, use **Download comments.csv** instead.
- **Session overview:** the bar above the strips shows the whole session. Click or drag it to scrub.
- **Step list:** click a step to jump to its start.
- **Keys:** `Space` play/pause, `←`/`→` 1 s (`Shift` for 5 s), `[`/`]` previous/next rep, `PgUp`/`PgDn` previous/next step, `C` comment. Speed goes from 0.25× to 2×.
- **Video sync** (±0.1 s) corrects a constant camera delay, e.g. against a clap. It is remembered per session.

If buttons ever seem dead, a red banner explains it. Press `⌘⇧R` and make sure the app runs from `start.command`. Its server (`serve.py`) turns off browser caching, so Chrome never mixes old and new app files.

Live view units: **Raw** (0–1000, as sent by the M40), **% MVC**, or **× Rest**. A sensor that is not calibrated for the chosen unit stays in raw and says so.

**Add simulated sensor (demo)** gives fake sensors that react to steps and reps, for training staff without the hardware.

## Files per session

The files go to `<save folder>/<subject>_<date_time>/`. Without a save folder, the Results tab offers them as downloads.

| File | Content |
|---|---|
| `video.mp4` (or `.webm`) | Camera recording. Streamed to disk while recording |
| `samples_long.csv` | Every sample: `t_s, video_t_s, t_arrival_s, seq, lost_before, sensor, site, side, raw, smoothed, step, phase` |
| `samples_wide_10Hz.csv` | 0.1 s grid, one column per sensor (raw and smoothed) |
| `events.csv` | Session start, video start, calibration, step start/end, every rep, symptoms, notes, sensor dropouts |
| `step_summary.csv` | Per step × sensor: mean, peak, %MVC, × rest, % active, reps, duration, symptom |
| `session.json` | Sensors (name, site, side, LED, serial, firmware), calibration, processing settings, rep times |

`t_s` is seconds since session start, with Bluetooth delivery jitter removed (see Timing below). `t_arrival_s` is when the packet actually reached the browser. `video_t_s = t_s − video.startOffset_s`, so you can seek the video to any sample, step or rep.
The data files are autosaved every 30 s. The video file is finalised when you press Stop, so stop the session before closing the tab.

## Processing (light)

- The M40 does its own EMG processing on the sensor: it samples at 4.8 kHz and sends an activation level of 0–1000 (0.1 % full scale) at 10 Hz. This app does not filter that signal again.
- **Smoothing**: moving average of 0.3, 0.5 (default) or 1.0 s, for the display and the `smoothed` column. The `raw` column is never altered.
- **Rest**: mean and SD after dropping the top 5 % of samples. **Active** means raw > rest mean + 3 SD.
- **MVC**: the highest 1 s moving average during the capture. Repeated captures keep the best. %MVC = level / MVC × 100.
- **Per step**: mean, peak (maximum of the smoothed signal), SD, level × seconds, and % of samples active.

## Analysis

Switch to **◧ Analysis** in the top bar, or press **◧ Analyse this session** in Results. It analyses the session open in Replay (or opens one), and every setting in its toolbar recomputes straight away.

1. **Activity vs rest.** Every sample of each exercise is shown as a distribution per sensor: median, middle 50 %, 5–95 %, against the rest median.
   - **AUC** is the chance that a sample from the exercise is higher than a rest sample. 0.5 means like rest; 0.8 or more (shown bold) means clearly above rest.
2. **Activations.** A burst is when the signal (0.3 s smoothing) rises above rest mean + k·SD (default 3) and stays there at least the minimum burst time (default 0.3 s). It ends below + (k−1)·SD.
   - A raster shows every burst across the session. Click it to open that moment in Replay.
   - Per step and sensor: **Active** (% of the step above threshold), **Reps with burst** (counted reps with a burst within ±0.75 s of the press) and **Onset** (median burst start relative to the press).
   - The **Rest (false alarms)** row shows how often detection fires at rest. Keep it near 0, otherwise raise k.
3. **Rep-locked stacks.** The signal around every rep press, or around every burst onset, is stacked per step:
   - single events as thin lines
   - the average as a thick line
   - ± 1 SD shaded
   - rest ± 1 SD as a grey band
   - the activation threshold dashed

   A grid shows all steps × sensors on a shared scale per sensor. Click a step for the detail.
4. **Behaviour clusters.**
   - **Windows:** the session is cut into windows (default 1 s, rest and exercises only). Each window is described by each sensor's level relative to rest (log scale), optionally plus variability.
   - **Clustering:** windows are grouped by k-means (default 4 clusters, fixed random seed, so the result is repeatable).
   - **Names:** patterns are named from which sensors are above their activation threshold, e.g. "Rest-like", "SCM R active", "Co-activation (all)".
   - **Charts:** **Patterns per exercise vs rest** shows how much of each exercise falls in each pattern, with "% active" = share of windows in a pattern with at least one sensor active. A scatter of all windows on the two main pattern axes highlights rest windows; click a dot to replay it.

**Rest reference:** the rest recording from Calibrate (default), the rests between steps, or both. With no rest at all, the quietest 20 % of samples is used, and the page says so.

**Export analysis** writes these files to `<session folder>/analysis/`, or downloads them:
- `analysis_groups.csv`
- `analysis_activation_steps.csv`
- `analysis_bursts.csv`
- `analysis_stacks.csv`
- `analysis_windows.csv`
- `analysis_clusters.csv`
- `analysis_settings.json`

## Timing and data quality

The M40 sends one value every 100 ms on its own clock, but Bluetooth delivers packets with a variable delay. It sometimes holds a few back and delivers them together, and occasionally loses one. On their own, arrival times jitter by about ±20–40 ms, and bursts misplace samples by up to a few hundred ms.

When the files are written, `js/timing.js` recovers the sensor's own rhythm:
1. It measures the sensor's true interval, including its clock drift, by tracking the earliest arrivals over time.
2. It numbers every interval (`seq`).
3. It gives each sample the send time of its interval (`t_s`).
4. Intervals with no sample are counted as lost (`lost_before`). Reconnects (gaps over 2 s) are fitted separately.

In simulated tests with realistic Bluetooth timing (bursts, losses, ±50 ppm clock error, sessions from 30 s to 2 h), cleaned timestamps were within about 1–2 ms of the true send times, and lost samples were counted exactly. The rare exception is a loss right next to a burst, where it is ambiguous which slot was lost.

- **Live:** each tile shows the rate and % lost over the last minute.
- **After the session:** Results shows a **Data quality** table, and session.json has a `timing` block per sensor.
- **In Replay:** lost samples appear as short red bars on the baseline.

### Sampling test (Sensors tab)

**Run fast-read test** reads one sensor's value on demand, as fast as Bluetooth allows, while the normal notifications keep coming. It then compares the two streams. If reading shows values the notifications never carried, the sensor has more than 10 Hz to give, and a fast-read recording mode would be worth adding. ANR's spec says the value updates 10 times a second, so expect "No gain". The test is disabled while a session is recording.

## Bluetooth details

These come from ANR's [BLE Design Guide](https://www.anrcorp.com/documents/BLE_DesignGuide.pdf) and the [M40 product sheet](https://www.anrcorp.com/documents/M40_ProductSheet.pdf).

| Item | Value |
|---|---|
| Advertising | Manufacturer data, company ID `0x05DA` |
| EMG level | Automation IO `0x1815` → Analog `0x2A58`. uint16 little-endian, 0–1000, notifies every 100 ms |
| LED colour pattern | Digital `0x2A56`. uint8, 1–24 (17–24 turn the LED off once connected, so the app uses 1–16) |
| Battery | `0x180F` / `0x2A19`, %. Read every 60 s (firmware ≥ 1.5) |
| Device info | `0x180A`: model, serial, firmware |

If a sensor drops out, the app keeps reconnecting in the background. The gap appears as a break in the trace and as an event in `events.csv`.

## Code layout

| File | Role |
|---|---|
| `js/ble.js` | M40 Bluetooth link |
| `js/sim.js` | Simulated sensor |
| `js/sensors.js` | Sensor list, names, LEDs, battery |
| `js/processing.js` | Smoothing, calibration, units, step statistics |
| `js/timing.js` | Timestamp clean-up and lost-sample detection |
| `js/analysis.js` | Analysis computations (groups, bursts, stacks, clusters) |
| `js/ui-analysis.js` | Analysis mode charts and export |
| `js/probe.js` | Fast-read sampling test |
| `js/session.js` | Logging, save folder, file export |
| `js/recorder.js` | Camera recording |
| `js/live.js` | Live strip charts and level tiles |
| `js/replay.js` | Replay mode: synced video and EMG, markers, comments |
| `js/folder.js` | Remembered save folder |
| `serve.py` | Local server with caching off |
| `tools/build_site.py` | Builds the version-stamped site for GitHub Pages |
| `.github/workflows/pages.yml` | Publishes to GitHub Pages on push to main |
| `js/ui-*.js` | The four tabs |
| `js/protocol.js` | Muscle sites, placement and MVC text, LED patterns, the 15 steps |

To change the cues or the placement text, edit `js/protocol.js`.

## Publishing on GitHub Pages

The app is static files, so GitHub Pages can host it. It then runs from `https://<user>.github.io/<repo>/`, and https means Bluetooth and the camera work there too. Anyone can then record, replay or analyse in the browser without installing anything. Direct links to a mode: `…/#replay` and `…/#analysis`.

**Privacy.** Session files are opened in the visitor's browser only. Nothing is uploaded, and the site has no server or analytics. `.gitignore` keeps recordings (videos, CSVs, session.json, analysis exports) out of the repository: never commit patient data. GitHub Pages sites are public unless your plan allows private Pages, so the code is public but data is not.

**One-time setup:**
1. Create an empty repository on GitHub (e.g. `m40-logger`).
2. In this folder (the local repository already exists, nothing is committed yet):
   ```bash
   git add -A
   git commit -m "M40 Neck EMG Logger"
   git remote add origin https://github.com/<user>/m40-logger.git
   git push -u origin main
   ```
3. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

**Every update:** after `git push`, the workflow in `.github/workflows/pages.yml` publishes the site within a minute or two. `tools/build_site.py` stamps every file with the commit version, so visitors never get a mix of old and new files from the browser cache. The version also ends up in each `session.json` (`version`).

**Try the published build locally:**
```bash
python3 tools/build_site.py && python3 -m http.server 8041 -d _site
```
Then open http://localhost:8041.
