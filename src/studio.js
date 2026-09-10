// The standalone video window. Same controls as the toolbar panel; this exists
// for the versions of Chrome that will not open that panel on our behalf.

import { mountVideoView } from './video-view.js';

const view = await mountVideoView(document.getElementById('video-root'));

const params = new URLSearchParams(location.search);
const src = params.get('src');
if (src) view.takePending(src, Number(params.get('tab')));
