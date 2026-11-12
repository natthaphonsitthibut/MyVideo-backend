/**
 * Product sound library (D-026): sound effects every merchant may use, referenced from a project by
 * `ProjectAsset.libraryId`. Source: the CC0-1.0 kit wyzowl/sfx-kit at commit {@link SOUND_LIBRARY_COMMIT}; the
 * numbers below are the kit's own metadata (`sounds.json`) for that commit. Files are not committed —
 * `pnpm library:fetch` downloads them and checks `sha256`.
 */
export type LibrarySound = {
  id: string;
  /** Path inside the kit. */
  file: string;
  sha256: string;
  durationSec: number;
  /**
   * Seconds into the file that must meet the moment (the hit / middle of a whoosh). A sound placed for a moment
   * starts at `moment − syncAtSec`.
   */
  syncAtSec: number;
  /** dB the sound comes down where it overlaps speech, so the voice stays clear (kit `under_voiceover_db`). */
  underVoiceoverDb: number;
};

export const SOUND_LIBRARY_COMMIT = '92780e7ab0cdfb557497a988089c47f46e8c7412';

const s = (
  id: string,
  dir: string,
  durationSec: number,
  syncAtSec: number,
  underVoiceoverDb: number,
  sha256: string,
): LibrarySound => ({
  id,
  file: `sounds/${dir}/${id}.wav`,
  sha256,
  durationSec,
  syncAtSec,
  underVoiceoverDb,
});

export const SOUND_LIBRARY: readonly LibrarySound[] = [
  s(
    'whoosh-fast-soft',
    'whooshes',
    0.25,
    0.099,
    -2,
    'ecc83a9cab2342eba9fa71dc321776156ffefbdcda2c672298fda385a4e0a103',
  ),
  s(
    'whoosh-fast-medium',
    'whooshes',
    0.252,
    0.096,
    -3,
    'b3cf3c589e738a62c1cc9bd3f620b69c831b64616427fdce57ba073d2a357a0d',
  ),
  s(
    'swish-soft',
    'swishes-and-zips',
    0.223,
    0.085,
    -2,
    'c18c581c43ac848b10c946e2a3c402b79370d99b057c2399b832d39f9d9236ab',
  ),
  s(
    'swish-medium',
    'swishes-and-zips',
    0.201,
    0.076,
    -3,
    '41a97a849f311cdb0da2de185386fc88e74db2df54d214bc8d9ff931b5e83c9c',
  ),
  s(
    'pop-small-in',
    'pops',
    0.04,
    0.01,
    -2,
    '917759c812aff57bca97627a3c89c7aa5f1b4be7c9494a352cd6ba1dc0984769',
  ),
  s(
    'pop-medium-in',
    'pops',
    0.06,
    0.011,
    -2,
    '0c92cb9be01b1b5a3b51d4a6bfe427947b228ea71bb95d5a0b6c8641b7eab511',
  ),
  s(
    'pop-medium-bubble',
    'pops',
    0.126,
    0.011,
    -2,
    '1e9da202369ae1c9d54eb1156e0217b9c1cc4a20aceba2c698d877539b104033',
  ),
  s(
    'pop-large-bubble',
    'pops',
    0.208,
    0.011,
    -2,
    '56f506f676c31359741540589958aab20151f947f5be1e76fe054e28d5bff38e',
  ),
  s(
    'money-register',
    'money',
    0.912,
    0.093,
    -3,
    '14a028b35622d610413a46da7374a170c6bb9bad62346397012cc90b23fb10b6',
  ),
  s(
    'money-coin-drop',
    'money',
    0.681,
    0.01,
    -3,
    '618325d7d3a72b17a5768c43bc7dc85087abcd10e0450106e19bc34ca601e579',
  ),
  s(
    'notification-attention-soft',
    'notifications',
    0.328,
    0,
    -3,
    'f4d75e08bdcfa6dc9f939cee8a973e2b9a7c96c6ef33d07ffebd20854dbde44a',
  ),
  s(
    'notification-success-ding-ding',
    'notifications',
    0.987,
    0,
    -3,
    '0be14f244abb4394f9815424de1e5128b84407f7fe3e830bff1aee26a72a178c',
  ),
  s(
    'notification-success-sparkle',
    'notifications',
    0.632,
    0,
    -3,
    '245345d810394ab269808dcc92eb0f0e3a9a7f03141432d90443dace73a10c67',
  ),
  s(
    'shimmer-short-soft',
    'shimmers',
    0.478,
    0.012,
    -3,
    'c0cdc8cc61e6b1dd0b16732161ff3967ad6242e2f673957bef88a49805c6286e',
  ),
  s(
    'shimmer-short-bright',
    'shimmers',
    0.511,
    0.013,
    -3,
    '58e22873154c4c993387b15754ddfedb44c6c676b648633483a29a46ff9577a1',
  ),
  s(
    'sting-bold-short',
    'logo-stings',
    1.708,
    0.304,
    -6,
    '977b14a6ba80e95405d85b9824c1409d8afc078c69e0c7fd05914956f80f2f93',
  ),
  s(
    'sting-playful-short',
    'logo-stings',
    1.237,
    0.131,
    -6,
    'b698931eae670f9ed5221122a3ab9cfb0b22073aeb7c2552b085ba9cd9a429a6',
  ),
  s(
    'sting-warm-short',
    'logo-stings',
    1.672,
    0.107,
    -6,
    '329c1a297186d212fd51fbe8730cd8075b9355e9f72011ea30f5b175962cb951',
  ),
  s(
    'sting-minimal-short',
    'logo-stings',
    1.263,
    0.1,
    -6,
    'e688de069518fed41c4f5e386d6eca3db95f73e450b36be5d067d7f7edd298c2',
  ),
  s(
    'sting-bright-short',
    'logo-stings',
    1.53,
    0.139,
    -6,
    '2d25bf1d1c6a8e8b2952074b5e4df86a18c86bfbec3f0ca31e563559e9559fc2',
  ),
];

export const SOUND_LIBRARY_IDS: readonly string[] = SOUND_LIBRARY.map((x) => x.id);

export function librarySound(id: string): LibrarySound | undefined {
  return SOUND_LIBRARY.find((x) => x.id === id);
}
