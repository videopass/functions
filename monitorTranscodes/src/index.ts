import type { Context, EventFunction } from '@google-cloud/functions-framework'
import { Firestore } from '@google-cloud/firestore'
import { CollectionNames, VideoApi, log } from '@videopass/services'
import { WhereFilterOp } from '@google-cloud/firestore'
import { CloudSchedulerClient } from '@google-cloud/scheduler'
import { TranscodedVideo, VideopassTranscodedVideo } from '@videopass/model'

/** is trigger --trigger-event providers/cloud.firestore/eventTypes/document.update --trigger-resource 'projects/videopass-io/databases/(default)/documents/files/{id}'", */
export const MonitorTranscodes: EventFunction = async (data: {}, context: Context) => {
	// https://cloud.google.com/functions/docs/create-deploy-gcloud
	// https://cloud.google.com/nodejs/docs/setup
	// https://github.com/GoogleCloudPlatform/nodejs-docs-samples/tree/main/functions
	// https://cloud.google.com/docs/authentication/provide-credentials-adc#on-prem
	// https://console.cloud.google.com/apis/enableflow?apiid=firestore.googleapis.com&project=videopass-io
	// https://firebase.google.com/docs/functions/typescript
	const db = new Firestore() //?
	await monitorTranscodeJobs(db)
	return null
}

async function monitorTranscodeJobs(db: Firestore) {
	try {
		// todo: check if names remain the same
		const inProgress = new Array<TranscodedVideo>()
		const queuedTranscodeJobs = await listBy(db, CollectionNames.files, 'progress', '<', 100) //?
		if (queuedTranscodeJobs.length === 0) await pauseSchedule()
		for (const item of queuedTranscodeJobs) {
			try {
				const videoApi = new VideoApi(process.env.REACT_APP_VIDEO_API_KEY, process.env.REACT_APP_VIDEO_API_SECRET)
				const inProgressVideo = (await videoApi.checkTranscodeProgress(item.id)).videos[0]
				inProgress.push(inProgressVideo)
			} catch (error) {
				log.error(error, `during check transcode progress ${item.id}`)
			}
		}
		await updateAll(db, CollectionNames.files, inProgress)
		await resumeSchedule()
	} catch (error) {
		log.error(error, 'during monitor transcode jobs')
	}
}

const scheduleName = 'MonitorTranscodes'
async function pauseSchedule() {
	try {
		const schedulerClient = new CloudSchedulerClient()
		log.info(`pause ${scheduleName}`)
		const response = await schedulerClient.pauseJob({ name: scheduleName })
		log.info(response)
	} catch (error) {
		log.error(error, `during pause schedule ${scheduleName} `)
	}
}

async function resumeSchedule() {
	try {
		log.info(`resume ${scheduleName}`)
		const schedulerClient = new CloudSchedulerClient()
		const response = await schedulerClient.resumeJob({ name: 'MonitorTranscodes' })
		log.info(response)
	} catch (error) {
		log.error(error, `during resume schedule ${scheduleName}`)
	}
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
