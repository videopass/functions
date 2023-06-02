import type { Context, EventFunction } from '@google-cloud/functions-framework'
import { Firestore } from '@google-cloud/firestore'
import { CollectionNames, DateHelper, VideoApi, log } from '@videopass/services'
import { WhereFilterOp } from '@google-cloud/firestore'
import { ActionState, FileAction, TranscodeUploadBodyExternal, VideopassAction, VideopassTranscodedVideo, VideopassVideo } from '@videopass/model'

/** is trigger --trigger-event providers/cloud.firestore/eventTypes/document.update --trigger-resource 'projects/videopass-io/databases/(default)/documents/actions/{id}'", */
export const MonitorActions: EventFunction = async (data: {}, context: Context) => {
	const db = new Firestore() //?
	await monitorActionJobs(db)
	return null
}

async function monitorActionJobs(db: Firestore) {
	try {
		const createdVideos = new Array<VideopassVideo>()
		const updatedActions = new Array<VideopassAction>()
		const createdActions = await listBy(db, CollectionNames.actions, 'state', '==', ActionState.created) //?
		for (const action of createdActions as unknown as VideopassAction[]) {
			try {
				const video = (await getVideo(db, action.mobId)) as VideopassTranscodedVideo
				log.info(`handle action ${action.id} for video ${video.id}`)
				let newVideo: VideopassVideo
				switch (action.action) {
					case FileAction.Delete:
						await deleteAction()
						break
					case FileAction.ChangeDRM:
						newVideo = await uploadAndTranscode(video)
						break
					case FileAction.AddDRM:
						newVideo = await uploadAndTranscode(video)
						break
					case FileAction.RemoveDRM:
						newVideo = await uploadAndTranscode(video)
						break
					case FileAction.TranscodeTo1080P:
						await transcodeAction()
						break
					case FileAction.Republish:
						newVideo = await uploadAndTranscode(video)
						break
					case FileAction.Retry:
						newVideo = await uploadAndTranscode(video)
						break
					default:
						break
				}
				const updatedAction = { ...action, state: ActionState.success }
				updatedActions.push(updatedAction)
				createdVideos.push(newVideo)
			} catch (error) {
				log.error(error, `during check transcode progress ${action.id}`)
			}
		}
		await updateAll(db, CollectionNames.actions, updatedActions)
		await updateAll(db, CollectionNames.files, createdVideos)
	} catch (error) {
		log.error(error, 'during monitor transcode jobs')
	}
}

/**
 * Can be used for change DRM, add DRM or remove DRM
 */
async function uploadAndTranscode(video: VideopassTranscodedVideo) {
	const videoApi = new VideoApi(process.env.REACT_APP_VIDEO_API_KEY, process.env.REACT_APP_VIDEO_API_SECRET)
	// todo: set ENV
	const src = `http://${process.env.REACT_APP_IP_EDGE_STORE}:${process.env.REACT_APP_PORT_EDGE_STORE}/api/v1/file?key=${video.edgeStore.key}&relpath=${video.edgeStore.relpath}` //?
	const transcodeUploadBody: TranscodeUploadBodyExternal = { playback_policy: 'public', source_uri: src }
	if (video.drm) transcodeUploadBody.nft_collection = video.drm

	const videoBody = await videoApi.transcodeExternalVideo(transcodeUploadBody) //?

	const uploadedVideo = videoBody.videos[0]
	const newVideo: VideopassVideo = {
		id: video.id,
		edgeStore: video.edgeStore,
		chain: video.chain,
		create_time: video.create_time,
		metadata: uploadedVideo.metadata,
		name: video.name,
		network: video.network,
		playback_policy: uploadedVideo.playback_policy,
		source_uri: uploadedVideo.source_uri,
		state: uploadedVideo.state,
		progress: uploadedVideo.progress,
		service_account_id: uploadedVideo.service_account_id,
		sub_state: uploadedVideo.sub_state,
		thetaId: uploadedVideo.id,
		update_time: uploadedVideo.update_time,
		drm: video.drm,
		error: uploadedVideo.error,
		use_drm: video.use_drm,
		create_unix: DateHelper.dayInUnix(video.create_time),
		update_unix: DateHelper.dayInUnix(uploadedVideo.update_time),
		videoId: video.videoId,
	}

	return newVideo
}

async function transcodeAction() {
	// todo: there is no option to transcode with different resolutions
}

async function deleteAction() {
	// todo: there is no option to delete a video from the api or edge store
}

async function getVideo(db: Firestore, id: string) {
	try {
		const doc = await db.collection(CollectionNames.files).doc(id).get()
		if (doc.exists) {
			return { id: doc.id, ...doc.data() }
		}
	} catch (error) {
		log.error(error, `${error} during get video ${id}`)
	}
	return null
}

async function listBy(db: Firestore, collection: string, field: string, whereFilter: WhereFilterOp, value: any) {
	try {
		let snapshot = await db.collection(collection).where(field, whereFilter, value).get()
		if (snapshot.empty) {
			return []
		}
		return snapshot.docs.map((doc) => {
			return Object.assign(Object.assign({}, doc.data()), { id: doc.id })
		})
	} catch (error) {
		log.error(error, `${error} during list by ${field} smaller then ${value} in ${collection}`)
	}
	return []
}

async function updateAll(db: Firestore, collectionName: string, docs: any[]) {
	const options = { merge: true }
	try {
		const batch = db.batch()
		docs.forEach((item) => {
			let { id, ...rest } = item
			const document = db.doc(`${collectionName}/${item.id}`)
			batch.set(document, rest, options)
		})
		await batch.commit()
	} catch (error) {
		log.error(error, `during update many in collection ${collectionName}`)
	}
}
