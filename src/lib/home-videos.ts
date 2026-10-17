/**
 * Looping videos that play in the two big tiles of the home page (they replace the collection pictures).
 * To change a video, put its YouTube id here (the part after `v=` or after `youtu.be/`). `poster` is the
 * picture shown until the video is playing, and to visitors who ask for reduced motion.
 */
export type HomeVideo = { id: string; poster: string };

export const HOME_VIDEOS: HomeVideo[] = [
  { id: 'BFNNHSTE_Io', poster: '/assets/slides/video-1.jpg' },
  { id: 'M359I4gJ9Os', poster: '/assets/slides/video-2.jpg' },
];

/**
 * Silent, no controls, endless loop. YouTube needs the id again as `playlist` to loop a single video, and
 * `enablejsapi` lets the page learn when playback has started (see public/js/storefront.js).
 */
export function youtubeEmbedUrl(id: string): string {
  const q = new URLSearchParams({
    autoplay: '1',
    mute: '1',
    loop: '1',
    playlist: id,
    controls: '0',
    modestbranding: '1',
    playsinline: '1',
    rel: '0',
    disablekb: '1',
    fs: '0',
    iv_load_policy: '3',
    enablejsapi: '1',
  });
  return `https://www.youtube-nocookie.com/embed/${id}?${q.toString()}`;
}
