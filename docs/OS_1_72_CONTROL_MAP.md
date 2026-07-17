# Analog Rytm OS 1.72 Control Map

This audit maps the [official Analog Rytm MKII OS 1.72 manual](https://www.elektron.se/wp-content/uploads/2025/01/Analog-Rytm-MKII-User-Manual_ENG_OS1.72_250130.pdf) to agent surfaces. It is intentionally broader than the boolean capability flags. `rytm_describe_capabilities` is the machine-readable authority for access, verification, transport, firmware evidence, rollback, and risk.

Status meanings:

- **Supported**: semantic agent operation exists and connected-hardware readback or capture evidence exists.
- **Partial**: a bounded subset is exposed; the limit is stated explicitly.
- **UI only**: safe for a human on the panel or in Elektron software, but no agent command exists.
- **Excluded**: destructive maintenance is intentionally absent.

## Interaction, Panel, And Projects

| Manual section | Status | Agent mapping and limit |
| --- | --- | --- |
| 6.2-6.5 parameter editing, copy/paste, naming | Partial | Semantic deltas replace panel gestures. Sound, Kit, Scene, Performance, Song, and Pattern-copy operations are exposed where listed below; arbitrary UI cursor/key emulation is absent. |
| 6.6 Overbridge | Partial | Hardware-certified optional provider inspection and synchronized Main/voice/input capture exist. Plug-in parameter automation is not a control dependency and is not exposed. |
| 6.7 class-compliant device | Supported | CoreAudio Main stereo inventory and bounded/start-stop WAV capture. |
| 6.8 backup and restore | Partial | Raw owned-object snapshots cover Pattern, Kit, Global, Settings, and all Songs. This is rollback evidence, not a whole-Project Elektron Transfer archive. |
| 8.1, 8.6 pads and MIDI notes | Partial | `trigger_track` covers the 12 track notes with velocity/duration. Arbitrary chromatic note performance and pad-pressure gestures are not exposed. |
| 8.2 machines | Supported | `set_track_machine` plus every compatible typed machine parameter. |
| 8.3-8.5 encoders and key behavior | UI only | No physical control emulation; use semantic operations. |
| 8.7 Play/Mute/Chromatic/Scene/Performance modes | Partial | Scene activation and Performance amounts are supported. Persistent track mute state is writable in Settings. Play/chromatic mode selection and panel mode workflows are not exposed as realtime commands. |
| 9.1 Project menu | UI only | Project load/save/manage and whole-project generation are not routine agent operations. |

## Kits, Sounds, And Effects

| Manual section | Status | Agent mapping and limit |
| --- | --- | --- |
| 10.1 +Drive Sound library and Sound Pool | UI only | Track Sounds are inspectable/editable in the active Kit. Library browse/tags, Sound Pool management, and Sound locks are not exposed. |
| 10.2.1-10.2.4 reload/load/save/clear Kit | UI only | The active Kit is edited declaratively and raw-snapshotted, but stored Kit slot lifecycle commands are absent. |
| 10.2.5 Track Routing Kit | Partial | Global route-to-main/send-to-FX flags are supported. Per-Kit override selection and masks are not modeled by the codec surface. |
| 10.2.6-10.2.7 Control In modulation macros | Inspect only | Four targets/amounts for each input are decoded in Kit inspection; no writer is exposed. |
| 10.3 Scene mode/edit | Supported | Inspect, set/replace/copy/clear definitions for Scenes 1-12 and activate/deactivate by CC or NRPN. Voice and FX locks share the 48-lock Kit pool. |
| 10.4 Performance mode/edit | Supported | Inspect, set/replace/copy/clear definitions and send amounts for Performance 1-12 by CC or NRPN. Live amount readback is unavailable, so values are transient send-cache state. |
| 10.4.2 Quick Performance | Partial | Individual macro amounts are writable. Panel assignment to the Quick Performance knob and Performance mute are UI-only. |
| 10.5 Sound browser/manager | UI only | Library browse, tags, copy-to-Sound-Pool, purge, rename/delete library entries, and stored Sound slot lifecycle are absent. |
| 10.5.3-10.5.5 active track Sound/settings | Supported | Active Kit Sound name, accent, chromatic mode, envelope/velocity/legacy flags, and velocity/aftertouch modulation targets/amounts are writable. Clear-to-default is not a dedicated operation. |
| 10.6-10.8 play/edit/select sample | Supported | Track trigger, machine/Sound pages, identity-bound sample upload/RAM resolution, and Sound sample assignment. Chromatic pad performance remains UI-only. |
| 10.9 effects | Supported | Delay, Reverb, Distortion, Compressor, FX LFO, sends, and levels are inspectable and writable through Kit SysEx. |
| Appendices A, B, D | Supported | Typed drum Sound pages, FX pages, compatible machine selection, and machine parameter families are exposed through semantic parameter registries. |

## Sequencer

| Manual section | Status | Agent mapping and limit |
| --- | --- | --- |
| 11.1.1-11.1.2 Pattern selection/control | Supported | Program change, start/stop/continue, generated or observed clock, and active Pattern readback. |
| 11.1.3 Page playback | UI only | Temporary page looping is not represented. |
| 11.1.4 tempo | Supported | Persistent Settings tempo plus generated transport tempo. Per-Pattern tempo is decoded but lacks a public delta operation. |
| 11.2 Pattern modes | Partial | Selected Pattern mode is persisted in Settings; Direct Start/Direct Jump timing gestures are not agent commands. |
| 11.3 grid/live/step recording | Partial | Declarative `set_trig`/`clear_trig` replaces grid entry. Live and step-recording UI modes are not remotely driven. |
| 11.4 Retrig menu | Partial | Trig retrig enable and per-track Kit retrig rate/length/velocity curve/always-on are exposed. Per-trig retrig rate, length, and velocity offset are not. |
| 11.5 Track menu | Partial | Track length and active Sound editing are exposed. Track defaults, sends-MIDI, pad scale/root, and track speed are inspect-only or absent. |
| 11.6 Pattern menu | Partial | Pattern copy is exposed. Clear/save/reload/import/export and stored Pattern lifecycle gestures are not dedicated operations. |
| 11.7.1 Trig page | Partial | Velocity, microtiming, condition, retrig enable, and parameter locks are exposed. Note, note length, sound lock, and accent/mute/swing/slide flags are not. |
| 11.7.2 Euclidean sequencer | UI only | Euclidean mode, pulse lengths, and rotations are present in the codec but not exposed by bridge deltas or summaries. |
| 11.8 Trigs Setup | UI only | Default trig note/velocity/length/probability/flags are not exposed. |
| 11.9 Fixed Velocity | Supported | Settings enable and amount are inspectable and writable. |
| 11.10 Click Track | Supported | Active, time signature, pre-roll bars, and volume are inspectable and writable. |
| 11.11 Scale normal/advanced | Partial | Track lengths, master length/time mode/swing inspection, and certified polymetric declarations exist. General per-track speed, master change, and all scale fields are not public deltas. |
| 11.12.1 Parameter locks | Supported | Set/clear track parameter locks with codec validation and Pattern readback. |
| 11.12.2 Sound locks | UI only | Sound Pool and trig Sound-lock values are not exposed. |
| 11.12.3 Conditional locks | Supported | Trig conditions, including ratios and probabilistic conditions accepted by the codec. |
| 11.12.4 Fill mode | Partial | Fill/not-fill trig conditions can be declared; realtime Fill-mode activation is not exposed. |
| 11.12.5-11.12.8 trig mute, accent, swing, slide | Partial | Pattern swing is inspectable and used by certified demo declarations. Individual trig flags and slide trigs are not public operations. |
| 11.12.9 copy/paste/clear | Partial | Pattern copy and individual trig/lock clear are semantic operations. Track/page copy gestures are absent. |
| 11.12.10 quick save/reload | UI only | Bridge snapshots are explicit and independent of the device's quick-save state. |
| Appendix C MIDI | Partial | Notes, transport, clock, program change, track level, Scene, and Performance mappings are exposed. The bridge does not present an unrestricted raw CC/NRPN/SysEx sender. |
| Appendix E pad scales | UI only | Pad-scale and root-note codec fields are not exposed by agent operations. |

## Chains, Songs, And Sampling

| Manual section | Status | Agent mapping and limit |
| --- | --- | --- |
| 12.1 Pattern chains | Partial | Pattern chains are declarative inside Song rows. Scratch chains, Chain mode activation, and live chain cursor editing are UI-only. |
| 12.2.1-12.2.3 Song edit/rows/repeats/mutes | Supported subset | Work buffer plus 16 stored Songs support names, rows, Pattern chains, repeats, and per-position track mutes with readback and rollback. |
| 12.2.4 Song menu/playback | UI only | Song load/save/clear lifecycle beyond definition writes, activation, playback cursor, loops, jumps, labels, tempo overrides, and Pattern-length overrides are not exposed. |
| 13.1 Sampling menu | Partial | Recorder source, threshold, monitor, and recording-length Settings are writable. Arm/record actions are not. |
| 13.2-13.3 sampling/direct sampling | UI only | Record, trim, normalize, rename, save, assign, and direct-sampling gestures remain panel workflows. Computer WAV transfer and Sound assignment are separately supported. |

## Global And System

| Manual section | Status | Agent mapping and limit |
| --- | --- | --- |
| 14.1 Project | UI only | Same Project lifecycle exclusion as section 9. |
| 14.2 Samples | Supported subset | +Drive/RAM/track inventory, upload with canonical download verification, RAM resolve/clear, and Sound assignment. Directory creation is implicit in managed upload; arbitrary move/rename/delete is absent. |
| 14.3 Global Slot | Partial | Work-buffer Global fields are inspectable/writable. Stored Global slot load/save lifecycle is absent. |
| 14.4 MIDI Config | Supported | Sync, port functions/transports, parameter output, receive flags, destinations, output channel policy, track/FX/auto/program/performance channels. |
| 14.5 SysEx Dump | Partial | Typed object query/write and bridge-owned raw snapshots use SysEx. Arbitrary all-object send/receive and user-selected dump files are not exposed. |
| 14.6 Audio Routing | Supported | Route-to-main, send-to-FX, USB input/output levels, and USB-to-main level with semantic active-high flags. Per-Kit overrides remain unsupported. |
| 14.7.1-14.7.2 Control inputs | Inspect only | Global input mode/polarity/range and Kit modulation targets are decoded where available but have no complete public writer. |
| 14.7.3 Sequencer Config | Supported | Kit reload on change, live-record quantization, and automatic track switch. |
| 14.8.1 LED intensity | UI only | No semantic write is exposed. |
| 14.8.2 USB Config | UI only | The human selects USB MIDI, USB AUDIO/MIDI, or OVERBRIDGE. The bridge detects mode but does not switch it. |
| 14.8.3 OS Upgrade | Excluded | Firmware maintenance is never agent-dispatched. |
| 14.8.4 Format +Drive | Excluded | Destructive storage formatting is never agent-dispatched. |
| 14.8.5 Storage | UI only | Sample inventory is exposed; device storage-statistics UI is not. |
| 14.8.6 Calibration | Excluded | Calibration can emit unsafe levels and is never agent-dispatched. |
| 15.1 Test Mode | Excluded | Hardware diagnostics and test tone are never agent-dispatched. |
| 15.2 Empty Reset | Excluded | Reset is never agent-dispatched. |
| 15.3 Factory Reset | Excluded | Factory reset is never agent-dispatched. |
| 15.4 OS Upgrade | Excluded | Startup-menu firmware update is never agent-dispatched. |
| 15.5 Exit | UI only | Startup menu navigation is not remotely controlled. |
| 17 Quick Keys | UI only/duplicate | Each musical action maps to the semantic rows above; panel shortcuts themselves are not emulated. |

## Certification Boundary

The maintained codec targets OS 1.70. Hardware evidence currently comes from one connected Analog Rytm MKII on OS 1.72 and certifies only the named object families and operations. A later OS must be treated as unverified until fixture decode, dry run, write/readback, and rollback tests pass again.
