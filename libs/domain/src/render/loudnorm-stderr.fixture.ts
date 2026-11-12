/**
 * Recorded ffmpeg stderr (2026-11-12, footage C03 first 15 s):
 * `ffmpeg -t 15 -i talkinghead-th-portrait.mp4 -vn -af loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json -f null -`
 * The JSON block is followed by more log lines.
 */
export const LOUDNORM_STDERR = [
  'size=N/A time=00:00:09.60 bitrate=N/A speed=  19x    [Parsed_loudnorm_0 @ 0xc27024540] ',
  '{',
  '\t"input_i" : "-17.59",',
  '\t"input_tp" : "-0.78",',
  '\t"input_lra" : "4.80",',
  '\t"input_thresh" : "-27.69",',
  '\t"output_i" : "-14.27",',
  '\t"output_tp" : "-1.50",',
  '\t"output_lra" : "3.80",',
  '\t"output_thresh" : "-24.35",',
  '\t"normalization_type" : "dynamic",',
  '\t"target_offset" : "0.27"',
  '}',
  '[out#0/null @ 0xc270243c0] video:0KiB audio:11250KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown',
  'size=N/A time=00:00:15.00 bitrate=N/A speed=21.7x',
].join('\n');
