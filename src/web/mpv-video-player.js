(function() {
    function getMediaStreamAudioTracks(mediaSource) {
        return mediaSource.MediaStreams.filter(s => s.Type === 'Audio');
    }

    // Convert Jellyfin global MediaStream.Index to 1-based type-relative index
    function getRelativeIndexByType(mediaStreams, jellyIndex, streamType) {
        let relIndex = 1;
        for (const source of mediaStreams) {
            if (source.Type !== streamType || source.IsExternal) continue;
            if (source.Index === jellyIndex) return relIndex;
            relIndex += 1;
        }
        return null;
    }

    function getStreamByIndex(mediaStreams, index) {
        return mediaStreams.find(s => s.Index === index) || null;
    }

    class mpvVideoPlayer extends window.MpvPlayerBase {
        constructor(args) {
            super(args);
            const { loading, appRouter, globalize, dashboard, playbackManager } = args;
            this.loading = loading;
            this.appRouter = appRouter;
            this.globalize = globalize;
            this.playbackManager = playbackManager;
            if (dashboard && dashboard.default) {
                this.setTransparency = dashboard.default.setBackdropTransparency.bind(dashboard);
            } else {
                this.setTransparency = () => {};
            }

            this.id = 'mpvvideoplayer';
            this.logTag = 'Video';
            this.name = 'MPV Video Player';
            this.syncPlayWrapAs = 'htmlvideoplayer';
            this.priority = -1;
            this.useFullSubtitleUrls = true;
            this.isLocalPlayer = true;
            this.isFetching = false;

            window._mpvVideoPlayerInstance = this;

            this._videoDialog = undefined;
            this._currentSrc = undefined;
            this._timeUpdated = false;
            this._currentPlayOptions = undefined;
            this._endedPending = false;

            this._videoEqStorageKey = 'jmpVideoEq';
            this._videoEq = this.loadVideoEq();
            this._darkBoostStorageKey = 'jmpDarkBoost';
            this._darkBoost = this.loadDarkBoost();

            // Support jellyfin-web v10.10.7
            this._currentAspectRatio = undefined;

            this.handlers.onPlaying = () => {
                if (!this._started) {
                    this._started = true;
                    this.loading.hide();
                    const dlg = this._videoDialog;
                    // Remove poster so video shows through from subsurface
                    if (dlg) {
                        const poster = dlg.querySelector('.mpvPoster');
                        if (poster) poster.remove();
                    }
                    // "fullscreen" = fills entire web content area, not the actual screen
                    if (this._currentPlayOptions?.fullscreen) {
                        this.appRouter.showVideoOsd();
                        if (dlg) dlg.style.zIndex = 'unset';
                    }
                    window.api.player.setVideoRectangle(0, 0, 0, 0);
                }
                this.applyVideoEq();
                this.applyDarkBoost();
                this._emitPlaying();
            };

            this.handlers.onTimeUpdate = (time) => {
                if (time && !this._timeUpdated) this._timeUpdated = true;
                this._seeking = false;
                this._currentTime = time;
                this.events.trigger(this, 'timeupdate');
            };

            this.handlers.onEnded = () => {
                if (!this._endedPending) {
                    this._endedPending = true;
                    this.onEndedInternal();
                }
            };

            this.handlers.onError = (error) => {
                this.removeMediaDialog();
                console.error(`[Media] [${this.logTag}] media error:`, error);
                this.events.trigger(this, 'error', [{ type: 'mediadecodeerror' }]);
            };
        }

        loadVideoEq() {
            const fallback = { brightness: 0, contrast: 0, gamma: 0 };
            try {
                const raw = window.localStorage.getItem(this._videoEqStorageKey);
                if (!raw) return fallback;
                const parsed = JSON.parse(raw);
                return {
                    brightness: Number.isFinite(parsed?.brightness) ? parsed.brightness : fallback.brightness,
                    contrast: Number.isFinite(parsed?.contrast) ? parsed.contrast : fallback.contrast,
                    gamma: Number.isFinite(parsed?.gamma) ? parsed.gamma : fallback.gamma
                };
            } catch (_err) {
                return fallback;
            }
        }

        saveVideoEq() {
            try {
                window.localStorage.setItem(this._videoEqStorageKey, JSON.stringify(this._videoEq));
            } catch (_err) {}
        }

        loadDarkBoost() {
            const fallback = { enabled: false, strength: 65 };
            try {
                const raw = window.localStorage.getItem(this._darkBoostStorageKey);
                if (!raw) return fallback;
                const parsed = JSON.parse(raw);
                return {
                    enabled: typeof parsed?.enabled === 'boolean' ? parsed.enabled : fallback.enabled,
                    strength: Number.isFinite(parsed?.strength) ? parsed.strength : fallback.strength
                };
            } catch (_err) {
                return fallback;
            }
        }

        saveDarkBoost() {
            try {
                window.localStorage.setItem(this._darkBoostStorageKey, JSON.stringify(this._darkBoost));
            } catch (_err) {}
        }

        applyVideoEq() {
            window.api.player.setBrightness(this._videoEq.brightness);
            window.api.player.setContrast(this._videoEq.contrast);
            window.api.player.setGamma(this._videoEq.gamma);
        }

        applyDarkBoost() {
            const strength = Math.max(0, Math.min(100, this._darkBoost.strength));
            window.api.player.setDarkBoostStrength(strength);
            window.api.player.setDarkBoostEnabled(this._darkBoost.enabled);
        }

        createVideoEqControls(container) {
            if (container.querySelector('.jmpEqToggle')) return;

            const controls = document.createElement('div');
            controls.className = 'jmpEqControls';
            controls.style.cssText = 'position:absolute;top:16px;right:16px;z-index:1200;font-family:inherit;color:#fff;';

            const toggle = document.createElement('button');
            toggle.className = 'jmpEqToggle';
            toggle.type = 'button';
            toggle.textContent = 'Image Controls';
            toggle.style.cssText = 'background:rgba(0,0,0,0.65);border:1px solid rgba(255,255,255,0.22);color:#fff;padding:8px 12px;border-radius:8px;cursor:pointer;';

            const panel = document.createElement('div');
            panel.className = 'jmpEqPanel';
            panel.style.cssText = 'display:none;margin-top:8px;min-width:260px;background:rgba(0,0,0,0.78);border:1px solid rgba(255,255,255,0.2);border-radius:10px;padding:12px;backdrop-filter:blur(3px);';

            const makeRow = (label, key) => {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:10px;margin:8px 0;';
                const title = document.createElement('span');
                title.textContent = label;
                title.style.cssText = 'width:78px;font-size:13px;opacity:0.95;';
                const slider = document.createElement('input');
                slider.type = 'range';
                slider.min = '-100';
                slider.max = '100';
                slider.step = '1';
                slider.value = String(this._videoEq[key]);
                slider.style.cssText = 'flex:1;';
                const value = document.createElement('span');
                value.textContent = String(this._videoEq[key]);
                value.style.cssText = 'width:34px;text-align:right;font-variant-numeric:tabular-nums;font-size:13px;';
                slider.addEventListener('input', () => {
                    const nextVal = Number.parseInt(slider.value, 10) || 0;
                    this._videoEq[key] = nextVal;
                    value.textContent = String(nextVal);
                    this.applyVideoEq();
                    this.saveVideoEq();
                });
                row.appendChild(title);
                row.appendChild(slider);
                row.appendChild(value);
                return row;
            };

            panel.appendChild(makeRow('Brightness', 'brightness'));
            panel.appendChild(makeRow('Contrast', 'contrast'));
            panel.appendChild(makeRow('Gamma', 'gamma'));

            const darkBoostWrap = document.createElement('div');
            darkBoostWrap.style.cssText = 'margin:10px 0 2px;';

            const darkBoostHeader = document.createElement('div');
            darkBoostHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;';
            const darkBoostLabel = document.createElement('span');
            darkBoostLabel.textContent = 'Adaptive Dark Boost';
            darkBoostLabel.style.cssText = 'font-size:13px;opacity:0.95;';
            const darkBoostToggle = document.createElement('input');
            darkBoostToggle.type = 'checkbox';
            darkBoostToggle.checked = !!this._darkBoost.enabled;
            darkBoostHeader.appendChild(darkBoostLabel);
            darkBoostHeader.appendChild(darkBoostToggle);
            darkBoostWrap.appendChild(darkBoostHeader);

            const darkBoostRow = document.createElement('div');
            darkBoostRow.style.cssText = 'display:flex;align-items:center;gap:10px;';
            const darkBoostStrengthLabel = document.createElement('span');
            darkBoostStrengthLabel.textContent = 'Strength';
            darkBoostStrengthLabel.style.cssText = 'width:78px;font-size:13px;opacity:0.95;';
            const darkBoostStrengthSlider = document.createElement('input');
            darkBoostStrengthSlider.type = 'range';
            darkBoostStrengthSlider.min = '0';
            darkBoostStrengthSlider.max = '100';
            darkBoostStrengthSlider.step = '1';
            darkBoostStrengthSlider.value = String(this._darkBoost.strength);
            darkBoostStrengthSlider.style.cssText = 'flex:1;';
            const darkBoostStrengthValue = document.createElement('span');
            darkBoostStrengthValue.textContent = String(this._darkBoost.strength);
            darkBoostStrengthValue.style.cssText = 'width:34px;text-align:right;font-variant-numeric:tabular-nums;font-size:13px;';
            darkBoostRow.appendChild(darkBoostStrengthLabel);
            darkBoostRow.appendChild(darkBoostStrengthSlider);
            darkBoostRow.appendChild(darkBoostStrengthValue);
            darkBoostWrap.appendChild(darkBoostRow);

            const syncDarkBoostUiState = () => {
                const enabled = !!this._darkBoost.enabled;
                darkBoostStrengthSlider.disabled = !enabled;
                darkBoostStrengthValue.style.opacity = enabled ? '1' : '0.5';
                darkBoostStrengthLabel.style.opacity = enabled ? '0.95' : '0.5';
            };

            darkBoostToggle.addEventListener('change', () => {
                this._darkBoost.enabled = !!darkBoostToggle.checked;
                this.applyDarkBoost();
                this.saveDarkBoost();
                syncDarkBoostUiState();
            });

            darkBoostStrengthSlider.addEventListener('input', () => {
                this._darkBoost.strength = Number.parseInt(darkBoostStrengthSlider.value, 10) || 0;
                darkBoostStrengthValue.textContent = String(this._darkBoost.strength);
                this.applyDarkBoost();
                this.saveDarkBoost();
            });

            syncDarkBoostUiState();
            panel.appendChild(darkBoostWrap);

            const actions = document.createElement('div');
            actions.style.cssText = 'display:flex;justify-content:flex-end;margin-top:10px;';
            const reset = document.createElement('button');
            reset.type = 'button';
            reset.textContent = 'Reset';
            reset.style.cssText = 'background:#1f2937;border:1px solid rgba(255,255,255,0.22);color:#fff;padding:6px 10px;border-radius:8px;cursor:pointer;';
            reset.addEventListener('click', () => {
                this._videoEq = { brightness: 0, contrast: 0, gamma: 0 };
                const sliders = panel.querySelectorAll('input[type="range"]');
                const values = panel.querySelectorAll('span[style*="tabular-nums"]');
                sliders.forEach((slider, idx) => {
                    if (idx > 2) return;
                    slider.value = '0';
                    if (values[idx]) values[idx].textContent = '0';
                });
                this.applyVideoEq();
                this.saveVideoEq();
            });
            actions.appendChild(reset);
            panel.appendChild(actions);

            toggle.addEventListener('click', () => {
                panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
            });

            controls.appendChild(toggle);
            controls.appendChild(panel);
            container.appendChild(controls);
        }

        async play(options) {
            console.log(`[Media] [${this.logTag}] play() called with options:`, options);
            this._started = false;
            this._timeUpdated = false;
            this._currentTime = null;
            this._endedPending = false;
            if (options.fullscreen) this.loading.show();  // fills entire web content area, not the actual screen
            await this.createMediaElement(options);
            console.log(`[Media] [${this.logTag}] createMediaElement done, calling setCurrentSrc`);
            const result = await this.setCurrentSrc(options);

            // needed when only audio is single external
            const externalAudio = options.mediaSource?.MediaStreams?.find(s => s.Type === 'Audio' && s.IsExternal);
            if (externalAudio && options.playMethod !== 'Transcode') {
                this.setAudioStreamIndex(externalAudio.Index);
            }
            return result;
        }

        get mediaType() { return 'video'; }

        _resolveTracks(options) {
            const streams = options.mediaSource?.MediaStreams || [];
            let defaultAudioIdx = options.mediaSource.DefaultAudioStreamIndex ?? -1;
            const defaultSubIdx = options.mediaSource.DefaultSubtitleStreamIndex ?? -1;

            if (defaultAudioIdx < 0) {
                const fallback = streams.find(s => s.Type === 'Audio' && !s.IsExternal)
                    ?? streams.find(s => s.Type === 'Audio');
                if (fallback) defaultAudioIdx = fallback.Index;
            }

            // Mirror jellyfin-web's UI selection exactly: feed mpv the relative
            // index for DefaultAudioStreamIndex, or TRACK_DISABLE if none is selected.
            // mpv auto track selection is completely disabled as it conflicts with
            // the fact that jellyfin-web is ultimately responsible for that.
            let audioParam = MpvPlayerBase.TRACK_DISABLE;
            let externalAudioUrl = null;
            if (options.playMethod === 'Transcode') {
                // Server bakes the chosen audio into the transcoded output
                // (single audio track in the m3u8). Source MediaStreams indexing
                // doesn't apply — see htmlVideoPlayer/plugin.js:514 for the same
                // logic. Don't audio-add either; audio is already in the stream.
                audioParam = 1;
            } else if (defaultAudioIdx >= 0) {
                const audioStream = getStreamByIndex(streams, defaultAudioIdx);
                if (audioStream && audioStream.DeliveryMethod === 'External' && audioStream.DeliveryUrl) {
                    externalAudioUrl = audioStream.DeliveryUrl;
                } else {
                    const relIdx = getRelativeIndexByType(streams, defaultAudioIdx, 'Audio');
                    audioParam = relIdx != null ? relIdx : MpvPlayerBase.TRACK_DISABLE;
                }
            }

            let subParam = MpvPlayerBase.TRACK_DISABLE;
            let externalSubUrl = null;
            if (defaultSubIdx >= 0) {
                const subStream = getStreamByIndex(streams, defaultSubIdx);
                if (subStream && subStream.DeliveryMethod === 'External' && subStream.DeliveryUrl) {
                    externalSubUrl = subStream.DeliveryUrl;
                } else {
                    const relIdx = getRelativeIndexByType(streams, defaultSubIdx, 'Subtitle');
                    subParam = relIdx != null ? relIdx : MpvPlayerBase.TRACK_DISABLE;
                }
            }

            return { audioParam, subParam, externalAudioUrl, externalSubUrl };
        }

        _beforeLoad() {
            window.api.player.setAspectMode(this.getAspectRatio());
        }

        setSubtitleStreamIndex(index) {
            if (index == null || index < 0) {
                window.api.player.setSubtitleStream(MpvPlayerBase.TRACK_DISABLE);
                return;
            }
            const streams = this._currentPlayOptions?.mediaSource?.MediaStreams || [];
            const stream = getStreamByIndex(streams, index);
            if (stream && stream.DeliveryMethod === 'External' && stream.DeliveryUrl) {
                window.api.player.addSubtitleStream(stream.DeliveryUrl);
                return;
            }
            const relIdx = getRelativeIndexByType(streams, index, 'Subtitle');
            window.api.player.setSubtitleStream(relIdx != null ? relIdx : MpvPlayerBase.TRACK_DISABLE);
        }

        setSecondarySubtitleStreamIndex(index) {}

        resetSubtitleOffset() {
            window.api.player.setSubtitleDelay(0);
        }

        enableShowingSubtitleOffset() {}
        disableShowingSubtitleOffset() {}
        isShowingSubtitleOffsetEnabled() { return false; }
        setSubtitleOffset(offset) { window.api.player.setSubtitleDelay(Math.round(offset * 1000)); }
        getSubtitleOffset() { return 0; }

        setAudioStreamIndex(index) {
            if (index == null || index < 0) {
                window.api.player.setAudioStream(MpvPlayerBase.TRACK_DISABLE);
                return;
            }
            const streams = this._currentPlayOptions?.mediaSource?.MediaStreams || [];
            const stream = getStreamByIndex(streams, index);
            if (stream?.IsExternal) {
                // External audio isn't part of the source container and the server
                // doesn't pre-publish a DeliveryUrl for it, so we can't audio-add
                // client-side. Re-enter playbackManager with canSetAudioStreamIndex
                // forced false so it routes through changeStream — the server then
                // regenerates the playback URL with the external audio attached.
                this._forceServerReload = true;
                try {
                    this.playbackManager.setAudioStreamIndex(index, this);
                } finally {
                    this._forceServerReload = false;
                }
                return;
            }
            const relIdx = getRelativeIndexByType(streams, index, 'Audio');
            window.api.player.setAudioStream(relIdx != null ? relIdx : MpvPlayerBase.TRACK_DISABLE);
        }

        stop(destroyPlayer) {
            if (!destroyPlayer && this._videoDialog && this._currentPlayOptions?.backdropUrl) {
                const dlg = this._videoDialog;
                const url = this._currentPlayOptions.backdropUrl;
                if (!dlg.querySelector('.mpvPoster')) {
                    const poster = document.createElement('div');
                    poster.classList.add('mpvPoster');
                    poster.style.cssText = `position:absolute;top:0;left:0;right:0;bottom:0;background:#000 url('${url}') center/cover no-repeat;`;
                    dlg.appendChild(poster);
                }
            }
            window.api.player.stop();
            this.handlers.onEnded();
            if (destroyPlayer) this.destroy();
            return Promise.resolve();
        }

        removeMediaDialog() {
            window.api.player.stop();
            if (window.jmpNative) window.jmpNative.playerOsdActive(false);
            window.api.player.setVideoRectangle(-1, 0, 0, 0);
            document.body.classList.remove('hide-scroll');
            const dlg = this._videoDialog;
            if (dlg) {
                this.setTransparency(0);
                this._videoDialog = null;
                dlg.parentNode.removeChild(dlg);
            }
        }

        destroy() {
            this.removeMediaDialog();
            this.disconnectSignals();

            // Support jellyfin-web v10.10.7
            this._currentAspectRatio = undefined;
        }

        createMediaElement(options) {
            let dlg = document.querySelector('.videoPlayerContainer');
            if (!dlg) {
                if (window.jmpNative) window.jmpNative.playerOsdActive(true);
                dlg = document.createElement('div');
                dlg.classList.add('videoPlayerContainer');
                dlg.style.cssText = 'position:fixed;top:0;bottom:0;left:0;right:0;display:flex;align-items:center;background:transparent;';
                if (options.fullscreen) dlg.style.zIndex = 1000;  // fills entire web content area, not the actual screen
                document.body.insertBefore(dlg, document.body.firstChild);
                this.setTransparency(2);
                this._videoDialog = dlg;

                this.connectSignals();
                if (window.jmpNative) {
                    window.jmpNative.notifyRateChange(this._playRate);
                }
                this.createVideoEqControls(dlg);
            } else {
                this._videoDialog = dlg;
            }
            if (options.backdropUrl) {
                const existing = dlg.querySelector('.mpvPoster');
                if (existing) existing.remove();
                const poster = document.createElement('div');
                poster.classList.add('mpvPoster');
                poster.style.cssText = `position:absolute;top:0;left:0;right:0;bottom:0;background:#000 url('${options.backdropUrl}') center/cover no-repeat;`;
                dlg.appendChild(poster);
            }
            if (options.fullscreen) document.body.classList.add('hide-scroll');  // fills entire web content area, not the actual screen
            return Promise.resolve();
        }

        canPlayMediaType(mediaType) {
            return (mediaType || '').toLowerCase() === 'video';
        }
        canPlayItem(item) { return this.canPlayMediaType(item.MediaType); }
        supportsPlayMethod() { return true; }
        static getSupportedFeatures() { return ['PlaybackRate', 'SetAspectRatio']; }
        supports(feature) { return mpvVideoPlayer.getSupportedFeatures().includes(feature); }
        isFullscreen() { return window._isFullscreen === true; }
        toggleFullscreen() {
            if (window.jmpNative) window.jmpNative.toggleFullscreen();
        }

        setPlaybackRate(value) {
            super.setPlaybackRate(value);
            if (window.jmpNative) window.jmpNative.notifyRateChange(value);
        }

        canSetAudioStreamIndex() { return !this._forceServerReload; }
        setPictureInPictureEnabled() {}
        isPictureInPictureEnabled() { return false; }
        isAirPlayEnabled() { return false; }
        setAirPlayEnabled() {}
        setBrightness(val) {
            if (!Number.isFinite(val)) return;
            this._videoEq.brightness = val;
            this.applyVideoEq();
            this.saveVideoEq();
        }

        getBrightness() {
            return this._videoEq.brightness;
        }

        togglePictureInPicture() {}
        toggleAirPlay() {}
        getStats() { return Promise.resolve({ categories: [] }); }
        getSupportedAspectRatios() {
            return [
                { id: 'auto',  name: this.globalize.translate('Auto') },
                { id: 'cover', name: this.globalize.translate('AspectRatioCover') },
                { id: 'fill',  name: this.globalize.translate('AspectRatioFill') }
            ];
        }
        getAspectRatio() {
            const aspectRatio = typeof this.appSettings.aspectRatio === 'function'
                ? this.appSettings.aspectRatio()
                // Support jellyfin-web v10.10.7
                : this._currentAspectRatio;

            return aspectRatio || 'auto';
        }
        setAspectRatio(value) {
            if (typeof this.appSettings.aspectRatio === 'function') {
                this.appSettings.aspectRatio(value);
            } else {
                // Support jellyfin-web v10.10.7
                this._currentAspectRatio = value;
            }
            window.api.player.setAspectMode(value);
        }
    }

    window._mpvVideoPlayer = mpvVideoPlayer;
    console.log('[Media] mpvVideoPlayer class installed');
})();
