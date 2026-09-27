package app.archivist.tv.player

import androidx.annotation.OptIn
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.ForwardingAudioSink
import androidx.media3.exoplayer.mediacodec.MediaCodecUtil

/**
 * The audio sink, with passthrough that can be turned off.
 *
 * Dolby and DTS audio go to the TV or soundbar still encoded, and encoded audio
 * cannot be played faster: the sink quietly holds the speed at 1×, so the speed
 * menu snapped back to Normal whatever was picked. With [decodeAll] set, the
 * sink declines encoded audio and the renderer decodes it to PCM here, which
 * can be played at any speed.
 */
@OptIn(UnstableApi::class)
class SpeedAudioSink(sink: AudioSink) : ForwardingAudioSink(sink) {
    var decodeAll = false

    /** Whether the audio now playing reached the sink still encoded: passthrough. */
    var passingThrough = false
        private set

    private fun declined(format: Format) = decodeAll && format.sampleMimeType != MimeTypes.AUDIO_RAW

    override fun supportsFormat(format: Format) = !declined(format) && super.supportsFormat(format)

    override fun getFormatSupport(format: Format) = if (declined(format)) AudioSink.SINK_FORMAT_UNSUPPORTED else super.getFormatSupport(format)

    override fun configure(inputFormat: Format, specifiedBufferSize: Int, outputChannels: IntArray?) {
        passingThrough = inputFormat.sampleMimeType != MimeTypes.AUDIO_RAW
        super.configure(inputFormat, specifiedBufferSize, outputChannels)
    }

    /** Whether the sink would take this format encoded, were passthrough allowed. */
    fun couldPassThrough(format: Format) = format.sampleMimeType != MimeTypes.AUDIO_RAW && super.supportsFormat(format)

    companion object {
        /** Whether this device can decode the format itself; DTS, often, it cannot. */
        fun canDecode(format: Format): Boolean {
            val mime = format.sampleMimeType ?: return false
            return runCatching { MediaCodecUtil.getDecoderInfos(mime, false, false).isNotEmpty() }.getOrDefault(false)
        }
    }
}
