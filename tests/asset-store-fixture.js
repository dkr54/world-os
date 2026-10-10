import { createCharacterAssetStore } from '../character-assets.js';

export function memoryAssetHost() {
    const files = new Map(), uploads = [];
    let inFlight = 0, peak = 0;
    const fixture = { files,uploads,failUpload:0,corrupt:false,async fetchFn(url,options = {}) {
        inFlight++; peak = Math.max(peak,inFlight);
        try {
            await Promise.resolve();
            if (url === '/api/images/upload') {
                const body = JSON.parse(options.body); uploads.push({ filename:body.filename,bytes:options.body.length });
                if (fixture.failUpload && uploads.length === fixture.failUpload) return new Response('',{status:507});
                const path = '/user/images/' + body.ch_name + '/' + body.filename + '.' + body.format;
                files.set(path,fixture.corrupt ? Buffer.from('damaged') : Buffer.from(body.image,'base64'));
                return Response.json({path:path.slice(1)});
            }
            return files.has(url) ? new Response(files.get(url)) : new Response('',{status:404});
        } finally { inFlight--; }
    },get peak() { return peak; }};
    fixture.store = createCharacterAssetStore({ fetchFn:fixture.fetchFn });
    return fixture;
}
