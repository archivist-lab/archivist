package app.archivist.tv.player

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.media.MediaCodecList
import android.net.Uri
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import androidx.annotation.OptIn
import androidx.core.content.res.ResourcesCompat
import app.archivist.tv.R
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
import androidx.media3.ui.PlayerView
import app.archivist.tv.TrackChoice
import app.archivist.tv.TrackChoices
import app.archivist.tv.api.ArchivistApi
import app.archivist.tv.api.AudioTrack
import app.archivist.tv.api.Segment
import app.archivist.tv.api.SubtitleTrack
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import app.archivist.tv.api.Tracks as ServerTracks

/**
 * Full-screen playback, on ExoPlayer.
 *
 * The file is played as it is on disk. ExoPlayer reads Matroska and MP4,
 * decodes whatever the television's hardware decodes — HEVC, AV1, Dolby
 * Digital — and passes surround formats through to a receiver that takes them.
 * Only when this device cannot play the audio or video actually chosen does it
 * fall back to the server's compatibility stream, as HLS; and there the picture
 * is copied untouched unless the device cannot decode it either, so the server
 * converts only what it must.
 *
 * Progress is written every ten seconds, on pause and on leaving, to the same
 * profile the web Player reads, so the two stay in step.
 */
@OptIn(UnstableApi::class)
class PlaybackActivity : Activity() {
    private val scope = MainScope()
    private lateinit var api: ArchivistApi
    private lateinit var queue: List<QueueItem>
    private var index = 0
    private lateinit var player: ExoPlayer
    private lateinit var view: PlayerView
    private lateinit var skip: Button
    private lateinit var notice: TextView
    private lateinit var audioSink: SpeedAudioSink
    /** The speed picked from the menu; the player's own can lag it while the audio is switched to be decoded. */
    private var speed = 1f

    private var serverTracks: ServerTracks? = null
    private var compat = false
    /** A start position for the compatibility stream, waiting for the encoder to reach it. */
    private var pendingSeekMs: Long? = null
    private var tickers: Job? = null
    private var skipTarget: (() -> Unit)? = null
    private var audioLanguage: String? = null
    private var subtitleLanguage: String? = null
    private var subtitleMode = "forced"
    private val choices by lazy { TrackChoices(this) }
    /** An audio language chosen for this title, which the fallback stream honours too. */
    private var choiceAudio: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        api = ArchivistApi(intent.getStringExtra(EXTRA_URL)!!, intent.getStringExtra(EXTRA_TOKEN))
        queue = QueueItem.decode(intent.getStringExtra(EXTRA_QUEUE)!!)
        index = intent.getIntExtra(EXTRA_INDEX, 0).coerceIn(0, queue.lastIndex)
        audioLanguage = intent.getStringExtra(EXTRA_AUDIO_LANGUAGE)
        subtitleLanguage = intent.getStringExtra(EXTRA_SUBTITLE_LANGUAGE)
        subtitleMode = intent.getStringExtra(EXTRA_SUBTITLE_MODE) ?: "forced"

        val selector = DefaultTrackSelector(this).apply {
            setParameters(buildUponParameters().apply {
                audioLanguage?.let { setPreferredAudioLanguage(it) }
                if (subtitleMode == "preferred") subtitleLanguage?.let { setPreferredTextLanguage(it) }
                // Forced subtitles (a translated sign) always show; "off" shows only those.
                if (subtitleMode != "preferred") setIgnoredTextSelectionFlags(C.SELECTION_FLAG_DEFAULT)
            })
        }
        player = ExoPlayer.Builder(this)
            .setRenderersFactory(object : DefaultRenderersFactory(this) {
                override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink =
                    SpeedAudioSink(super.buildAudioSink(context, enableFloatOutput, enableAudioTrackPlaybackParams)!!).also { audioSink = it }
            }.setEnableDecoderFallback(true))
            .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(api.http)))
            .setTrackSelector(selector)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .setSeekBackIncrementMs(10_000)
            .setSeekForwardIncrementMs(30_000)
            .build()
        player.addListener(listener)

        view = PlayerView(this).apply {
            // The speed menu goes through [setSpeed], which can take encoded audio off passthrough first.
            player = object : ForwardingPlayer(this@PlaybackActivity.player) {
                override fun setPlaybackParameters(parameters: PlaybackParameters) = setSpeed(parameters.speed)
                override fun setPlaybackSpeed(speed: Float) = setSpeed(speed)
                override fun getPlaybackParameters(): PlaybackParameters = super.getPlaybackParameters().withSpeed(this@PlaybackActivity.speed)
            }
            setBackgroundColor(Color.BLACK)
            setShowSubtitleButton(true)
            setShowNextButton(false)
            setShowPreviousButton(false)
            setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
            controllerShowTimeoutMs = 4_000
            keepScreenOn = true
        }
        val mono = ResourcesCompat.getFont(this, R.font.bebas_neue_pro_regular_caps)
        skip = Button(this).apply {
            visibility = View.GONE
            typeface = mono
            letterSpacing = .08f
            isAllCaps = true
            setTextColor(Color.BLACK)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            setPadding(dp(22), dp(10), dp(22), dp(10))
            background = GradientDrawable().apply { cornerRadius = dp(10).toFloat(); setColor(Color.WHITE) }
            setOnClickListener { skipTarget?.invoke() }
        }
        notice = TextView(this).apply {
            visibility = View.GONE
            typeface = ResourcesCompat.getFont(this@PlaybackActivity, R.font.bebas_neue_pro_book)
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setPadding(dp(16), dp(8), dp(16), dp(8))
            background = GradientDrawable().apply { cornerRadius = dp(18).toFloat(); setColor(0xCC05050A.toInt()) }
        }
        setContentView(FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            addView(skip, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply { setMargins(0, 0, dp(56), dp(120)) })
            addView(notice, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { setMargins(0, dp(28), 0, 0) })
        })
        start(index)
    }

    private fun dp(value: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

    // ── Loading ──────────────────────────────────────────────────────────────

    /**
     * The audio and subtitles chosen for this title from its tile's menu, over
     * the profile's own preferences. By language, so they hold across a
     * series' episodes, each a file of its own.
     */
    private fun applyChoice(item: QueueItem) {
        val choice = item.choiceKey?.let { choices.get(it) } ?: return
        choiceAudio = choice.audioLanguage
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon().apply {
            choice.audioLanguage?.let { setPreferredAudioLanguage(it) }
            when (val subtitles = choice.subtitles) {
                TrackChoice.Subtitles.Default -> setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                TrackChoice.Subtitles.Off -> setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
                is TrackChoice.Subtitles.Language -> setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false).setPreferredTextLanguage(subtitles.code).setIgnoredTextSelectionFlags(0)
            }
        }.build()
    }

    private fun start(position: Int) {
        index = position
        choiceAudio = null
        applyChoice(queue[position])
        compat = false
        pendingSeekMs = null
        serverTracks = null
        hideSkip()
        val item = queue[index]
        scope.launch {
            // The server's track list names sidecar subtitles and the intro and
            // credits markers. Playback does not wait long for it.
            serverTracks = withTimeoutOrNull(3_000) { runCatching { api.tracks(item.kind, item.id) }.getOrNull() }
            val sidecars = serverTracks?.subtitles.orEmpty().filter { it.index < 0 }.map { subtitle(item, it) }
            player.setMediaItem(mediaItem(item, api.resolve(item.streamPath)!!, null, sidecars), (item.resumeSeconds * 1000).toLong())
            player.prepare()
            player.playWhenReady = true
            startTickers()
        }
    }

    private fun mediaItem(item: QueueItem, url: String, mime: String?, subtitles: List<MediaItem.SubtitleConfiguration>) = MediaItem.Builder()
        .setUri(url)
        .apply { if (mime != null) setMimeType(mime) }
        .setSubtitleConfigurations(subtitles)
        .setMediaMetadata(MediaMetadata.Builder().setTitle(item.title).setSubtitle(item.subtitle).build())
        .build()

    private fun subtitle(item: QueueItem, track: SubtitleTrack) = MediaItem.SubtitleConfiguration.Builder(Uri.parse(api.subtitleUrl(item.kind, item.id, track.index)))
        .setMimeType(MimeTypes.TEXT_VTT)
        .setLanguage(track.language)
        .setLabel(track.title ?: track.language ?: "Subtitles")
        .setSelectionFlags(if (track.forced) C.SELECTION_FLAG_FORCED else 0)
        .build()

    /**
     * The server's compatibility stream, as HLS. Starts at zero so the stream's
     * clock is the title's, and seeks on to [pendingSeekMs] once the encoder has
     * got that far — seconds, when the picture is copied.
     */
    private fun fallBack(reason: String, audio: AudioTrack?, videoUnsupported: Boolean) {
        if (compat) return
        compat = true
        val item = queue[index]
        val position = if (player.currentPosition > 1_000) player.currentPosition else (item.resumeSeconds * 1000).toLong()
        val copy = if (videoUnsupported) emptyList() else decodableVideo()
        // The transcode drops embedded subtitles, so every text one is side-loaded from the server.
        val subtitles = serverTracks?.subtitles.orEmpty().filter { it.textBased }.map { subtitle(item, it) }
        player.setMediaItem(mediaItem(item, api.hlsUrl(item.kind, item.id, audio?.index, copy), MimeTypes.APPLICATION_M3U8, subtitles), 0L)
        player.prepare()
        player.playWhenReady = true
        pendingSeekMs = position.takeIf { it > 1_000 }
        show(reason)
    }

    /** The server's audio track this device should hear: the preferred language, else the default. */
    private fun chosenAudio(): AudioTrack? {
        val audio = serverTracks?.audio.orEmpty()
        val wanted = (choiceAudio ?: audioLanguage)?.lowercase()
        return audio.firstOrNull { wanted != null && ((it.languageCode ?: it.language)?.lowercase()?.startsWith(wanted.take(2)) == true) }
            ?: audio.firstOrNull { it.isDefault } ?: audio.firstOrNull()
    }

    private val listener = object : Player.Listener {
        override fun onTracksChanged(tracks: androidx.media3.common.Tracks) {
            if (compat) return
            val video = tracks.groups.filter { it.type == C.TRACK_TYPE_VIDEO }
            val audio = tracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }
            if (video.isEmpty() && audio.isEmpty()) return
            val videoUnsupported = video.isNotEmpty() && video.none { it.isSupported }
            // Containers list tracks in stream order, as the server does, so the
            // chosen track's place among the server's is its place here.
            val chosen = chosenAudio()
            val place = serverTracks?.audio?.indexOf(chosen) ?: -1
            val chosenUnsupported = place in audio.indices && !audio[place].isSupported
            val noAudio = audio.isNotEmpty() && audio.none { it.isSupported }
            when {
                videoUnsupported -> fallBack("This TV can’t decode this video — the server is converting it", chosen, true)
                noAudio || chosenUnsupported -> fallBack("Converting ${chosen?.codec?.uppercase() ?: "the"} audio for this TV", chosen, false)
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            if (!compat) { fallBack("Switching to the compatibility stream", chosenAudio(), false); return }
            show("Playback failed: ${error.errorCodeName}")
        }

        override fun onPlaybackStateChanged(state: Int) {
            if (state == Player.STATE_ENDED) finishItem()
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (!isPlaying) save()
        }
    }

    private fun startTickers() {
        tickers?.cancel()
        tickers = scope.launch {
            var since = 0L
            while (isActive) {
                delay(500)
                since += 500
                if (since >= 10_000) { since = 0; if (player.isPlaying) save() }
                pendingSeekMs?.let { target ->
                    val window = player.duration
                    if (window != C.TIME_UNSET && window >= target) { pendingSeekMs = null; player.seekTo(target) }
                }
                updateSkip()
            }
        }
    }

    // ── Skip intro, credits and next episode ─────────────────────────────────

    private fun updateSkip() {
        val tracks = serverTracks ?: return hideSkip()
        val at = player.currentPosition / 1000.0
        fun active(segment: Segment?) = segment != null && at >= segment.start - 1 && at < segment.end - .25
        val hasNext = index < queue.lastIndex
        when {
            active(tracks.intro) -> showSkip("Skip intro") { player.seekTo(((tracks.intro!!.end + .1) * 1000).toLong()) }
            active(tracks.credits) && hasNext -> showSkip("Next episode") { finishItem() }
            active(tracks.credits) -> showSkip("Skip credits") { player.seekTo(((tracks.credits!!.end + .1) * 1000).toLong()) }
            else -> hideSkip()
        }
    }

    private fun showSkip(label: String, action: () -> Unit) {
        skipTarget = action
        if (skip.visibility != View.VISIBLE || skip.text != label) {
            skip.text = "$label   OK"
            skip.visibility = View.VISIBLE
        }
    }

    private fun hideSkip() {
        skipTarget = null
        skip.visibility = View.GONE
    }

    private fun show(message: String) {
        notice.text = message
        notice.visibility = View.VISIBLE
        notice.removeCallbacks(hideNotice)
        notice.postDelayed(hideNotice, 5_000)
    }

    /**
     * Play at [value]. Audio passed through to the TV still encoded cannot be
     * sped up, so for any speed but 1× it is decoded here instead; the audio
     * renderer is restarted to take the change, a moment's gap in the sound.
     * Back at 1×, passthrough returns the same way.
     */
    private fun setSpeed(value: Float) {
        val format = player.audioFormat
        val decode = value != 1f
        val restart = format != null && when {
            decode -> audioSink.passingThrough
            else -> audioSink.decodeAll && audioSink.couldPassThrough(format)
        }
        if (decode && restart && !SpeedAudioSink.canDecode(format!!)) {
            show("This ${codecName(format.sampleMimeType)} audio goes straight to your TV or soundbar, so its speed can’t change. Pick another audio track to change speed.")
            return
        }
        speed = value
        audioSink.decodeAll = decode
        if (!restart) { player.setPlaybackSpeed(value); return }
        val tracks = player.trackSelectionParameters
        player.trackSelectionParameters = tracks.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, true).build()
        scope.launch {
            // Apart, so the player sees the audio go and come back rather than one change that cancels out.
            delay(250)
            player.trackSelectionParameters = tracks
            player.setPlaybackSpeed(value)
        }
    }

    private fun codecName(mime: String?) = when (mime) {
        MimeTypes.AUDIO_DTS, MimeTypes.AUDIO_DTS_HD, MimeTypes.AUDIO_DTS_EXPRESS, MimeTypes.AUDIO_DTS_X -> "DTS"
        MimeTypes.AUDIO_TRUEHD -> "Dolby TrueHD"
        MimeTypes.AUDIO_AC3, MimeTypes.AUDIO_E_AC3, MimeTypes.AUDIO_E_AC3_JOC, MimeTypes.AUDIO_AC4 -> "Dolby"
        else -> "surround"
    }

    private val hideNotice = Runnable { notice.visibility = View.GONE }

    // ── Progress ─────────────────────────────────────────────────────────────

    private fun save(completed: Boolean = false) {
        val item = queue.getOrNull(index) ?: return
        val position = player.currentPosition / 1000.0
        val duration = serverTracks?.durationSeconds ?: (player.duration.takeIf { it != C.TIME_UNSET }?.div(1000.0)) ?: return
        if (duration <= 0 || (position < 5 && !completed)) return
        val done = completed || position / duration >= .95
        // Outlives this screen: the last save is made as it closes.
        PROGRESS.launch {
            runCatching { api.saveProgress(item.kind, item.id, if (done) duration else position, duration, done, item.editionId) }
        }
    }

    private fun finishItem() {
        save(completed = true)
        if (index < queue.lastIndex) start(index + 1) else finish()
    }

    // ── The remote ───────────────────────────────────────────────────────────

    override fun dispatchKeyEvent(original: KeyEvent): Boolean {
        // A controller's A and B work as the remote's OK and Back here too.
        val event = app.archivist.tv.retro.ControllerNavigation.asRemote(original) ?: original
        val controls = view.isControllerFullyVisible
        val ok = event.keyCode == KeyEvent.KEYCODE_DPAD_CENTER || event.keyCode == KeyEvent.KEYCODE_ENTER
        // With the controls hidden, OK takes the offer on screen: skip the intro.
        if (ok && !controls && skip.visibility == View.VISIBLE) {
            if (event.action == KeyEvent.ACTION_UP) skipTarget?.invoke()
            return true
        }
        if (event.keyCode == KeyEvent.KEYCODE_BACK) {
            // Back hides the controls first, then leaves.
            if (event.action == KeyEvent.ACTION_UP) { if (controls) view.hideController() else leave() }
            return true
        }
        // Left and Right seek straight away when the controls are hidden, and bring them up to show where.
        if (!controls && event.action == KeyEvent.ACTION_DOWN && (event.keyCode == KeyEvent.KEYCODE_DPAD_LEFT || event.keyCode == KeyEvent.KEYCODE_DPAD_RIGHT)) {
            if (event.keyCode == KeyEvent.KEYCODE_DPAD_LEFT) player.seekBack() else player.seekForward()
            view.showController()
            return true
        }
        return view.dispatchKeyEvent(event) || super.dispatchKeyEvent(event)
    }

    private fun leave() {
        save()
        finish()
    }

    override fun onStop() {
        super.onStop()
        save()
        player.pause()
    }

    override fun onDestroy() {
        tickers?.cancel()
        scope.cancel()
        player.removeListener(listener)
        player.release()
        super.onDestroy()
    }

    /** ffprobe names of the video codecs this device has a hardware or software decoder for. */
    private fun decodableVideo(): List<String> {
        val types = runCatching {
            MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { !it.isEncoder }.flatMap { it.supportedTypes.toList() }.map { it.lowercase() }.toSet()
        }.getOrDefault(emptySet())
        return VIDEO_MIMES.filter { (_, mime) -> mime in types }.keys.toList()
    }

    companion object {
        const val EXTRA_URL = "url"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_QUEUE = "queue"
        const val EXTRA_INDEX = "index"
        const val EXTRA_AUDIO_LANGUAGE = "audioLanguage"
        const val EXTRA_SUBTITLE_LANGUAGE = "subtitleLanguage"
        const val EXTRA_SUBTITLE_MODE = "subtitleMode"

        private val VIDEO_MIMES = mapOf("h264" to "video/avc", "hevc" to "video/hevc", "av1" to "video/av01", "vp9" to "video/x-vnd.on2.vp9")
        private val PROGRESS = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }
}
