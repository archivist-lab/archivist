package app.archivist.tv.player

import app.archivist.tv.api.MediaKind
import org.json.JSONArray
import org.json.JSONObject

/** One thing to play: a film, or an episode in a run of them. */
data class QueueItem(
    val kind: MediaKind,
    val id: Int,
    val title: String,
    val subtitle: String?,
    val streamPath: String,
    val resumeSeconds: Double,
    val editionId: Int?,
    /** Where this title's audio and subtitle choices are kept (see TrackChoices): `film:7`, `series:2`. */
    val choiceKey: String? = null,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("kind", kind.name).put("id", id).put("title", title).put("subtitle", subtitle ?: JSONObject.NULL)
        .put("stream", streamPath).put("resume", resumeSeconds).put("edition", editionId ?: JSONObject.NULL)
        .put("choice", choiceKey ?: JSONObject.NULL)

    companion object {
        fun encode(items: List<QueueItem>): String = JSONArray().apply { items.forEach { put(it.toJson()) } }.toString()

        fun decode(raw: String): List<QueueItem> {
            val array = JSONArray(raw)
            return (0 until array.length()).map { index ->
                val json = array.getJSONObject(index)
                QueueItem(
                    kind = MediaKind.valueOf(json.getString("kind")),
                    id = json.getInt("id"),
                    title = json.optString("title"),
                    subtitle = if (json.isNull("subtitle")) null else json.optString("subtitle"),
                    streamPath = json.getString("stream"),
                    resumeSeconds = json.optDouble("resume", 0.0),
                    editionId = if (json.isNull("edition")) null else json.optInt("edition"),
                    choiceKey = if (json.isNull("choice") || !json.has("choice")) null else json.optString("choice"),
                )
            }
        }
    }
}
