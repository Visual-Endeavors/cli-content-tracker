import { promises as fs } from 'fs'
import * as path from 'path'
import _ from 'lodash'
import { logger } from './logger.js' // TODO: remove all logging from here...

import PQueue from 'p-queue'

import { Level } from 'level'
const db = new Level('./.db', { valueEncoding: 'json' })

import ffprobeStatic from 'ffmpeg-ffprobe-static'
import FfmpegCommand from 'fluent-ffmpeg'

import { DropboxService } from './DropboxService.js'

FfmpegCommand.setFfmpegPath(ffprobeStatic.ffmpegPath)
FfmpegCommand.setFfprobePath(ffprobeStatic.ffprobePath)

import { Metadata, MetadataFolder, MetadataFileMedia, MetadataFile } from './Metadata.js'

const metadataFolder = new MetadataFolder()
const metadataFile = new MetadataFile()
const metadataFileMedia = new MetadataFileMedia()

export const dirFields = metadataFolder._keys
export const fileFields = metadataFile._keys
export const fileMediaFields = metadataFileMedia._keys

export const dirDefaults = metadataFolder.fields
export const fileDefaults = metadataFile.fields
export const fileMediaDefaults = metadataFileMedia.fields

const defaultRListOptions = {
	rootPath: '',
	rules: {
		dirs: {
			includes: [],
			excludes: []
		},
		files: {
			includes: [],
			excludes: []
		}
	},
	mediaMetadata: true,
	limitToFirstFile: false,
	concurrency: 10
}

/**
 * Get the contents of all the dirs recursively
 * @param {array} dirs array of folder path
 * @param {object} options rules, mediaMetadata, limitToFirstFile & concurrency
 * @returns object containing the arrays of MetadataFolder & MetadataFile(Media)
 */
export async function rLists(dirs = [], options = {}) {
	logger.verbose('Scanning folders');
	
	const results = {
		dirs: [],
		files: []
	};

	for (const dir of dirs) {
		const result = await rList(dir, options);  // Pass the options through
		results.dirs.push(...result.dirs);
		results.files.push(...result.files);
	}

	logger.info(`Found ${results.dirs.length} folders & ${results.files.length} files `);
	return results;
}

/**
 * Recursively get all the contained files and folders for the given dir
 * @param {string} dir 
 * @param {object} object rules, mediaMetadata, limitToFirstFile & concurrency
 * @returns object containing the arrays of MetadataFolder & MetadataFile(Media)
 */
export async function rList(dir, options = {}) {
	const result = {
		dirs: [],
		files: []
	}

	const ALLOWED_EXTENSIONS = ['.png', '.mov'];

	logger.debug("rList called with:", {
		dir,
		hasDropbox: !!options.dropbox
	})

	if (!options.dropbox?.appKey) {
		logger.warn("Missing Dropbox app key, falling back to local filesystem")
		return result
	}

	try {
		logger.debug("Initializing Dropbox service")
		const dropbox = new DropboxService({
			appKey: options.dropbox.appKey,
			teamMemberEmail: options.dropbox.teamMemberEmail,
			rootPath: options.dropbox.rootPath
		})
		
		logger.debug("Starting Dropbox authentication")
		await dropbox.init()
		
		logger.debug("Listing folder:", dir)
		const entries = await dropbox.listFolder(dir)
		
		// Process entries with file extension filtering
		for (const entry of entries) {
			const path = entry.path_display;
			
			if (entry['.tag'] === 'folder') {
				result.dirs.push({
					path: path,
					name: path.split('/').pop()
				});
			} else if (entry['.tag'] === 'file') {
				// Check if file has allowed extension
				const extension = path.toLowerCase().slice(path.lastIndexOf('.'));
				if (ALLOWED_EXTENSIONS.includes(extension)) {
					result.files.push({
						path: entry.path_display,
						name: entry.name,
						size: entry.size,
						type: extension.slice(1),
						created: entry.client_modified,
						modified: entry.server_modified,
						width: entry.metadata?.dimensions?.width,
						height: entry.metadata?.dimensions?.height,
						duration: entry.metadata?.duration
					});
				}
			}
		}
		
		logger.debug(`Found ${result.dirs.length} directories and ${result.files.length} files`, {
			dirs: result.dirs.map(d => d.path),
			files: result.files.map(f => f.path)
		});
		return result
	} catch (error) {
		logger.error("Dropbox error:", {
			status: error.status,
			message: error.message,
			details: error.response?.data
		})
		return result
	}
}

// Helper function to process Dropbox metadata
async function processDropboxMetadata(fileMeta, dropboxMeta) {
	const mediaMeta = new MetadataFileMedia(fileMeta.all)
	
	if (dropboxMeta.media_info) {
		const metadata = dropboxMeta.media_info.metadata
		mediaMeta.duration = metadata.duration || 0
		mediaMeta.video = metadata.dimensions ? true : false
		mediaMeta.videoWidth = metadata.dimensions?.width || 0
		mediaMeta.videoHeight = metadata.dimensions?.height || 0
		// ... set other media metadata fields as available
	}

	return mediaMeta
}

/**
 * Get all the metadata for a file using 
 * @param {MetadataFile} fileMeta MetadataFile object containing a path to the item
 * @returns {Promise} resolve contains Metadata object
 */
function getFileMetadata(fileMeta) {
	return new Promise((resolve, reject) => {
		FfmpegCommand.ffprobe(fileMeta.fullPath, async (err, metadata) => {
			if(err)
				reject(err)

			let mediaMeta = new MetadataFileMedia(fileMeta.all)

			let cacheMeta
			try{
				cacheMeta = await db.get(fileMeta.fullPath)
			}
			catch(err) {
				logger.silly("No cache found for %s", mediaMeta.fullPath)
			}

			if(cacheMeta !== undefined 
				&& cacheMeta.size == mediaMeta.size 
				&& cacheMeta.mtime == mediaMeta.mtime) {
				// found the item in cache and it matches the size and last modified time
				
				logger.silly("Retreived cached metadata for %s", mediaMeta.fullPath)
				mediaMeta.all = cacheMeta
				resolve(mediaMeta)
			}
			else {
				logger.silly("Fetching metadata for %s", mediaMeta.fullPath)
			
				const videoStream = metadata?.streams.find((stream) => stream.codec_type == 'video')
				const audioStream = metadata?.streams.find((stream) => stream.codec_type == 'audio')
		
				mediaMeta.video = videoStream !== undefined
				mediaMeta.videoStill = metadata?.format?.format_long_name.includes("sequence") ?? false
				
				// see if it's there
				let duration = metadata?.format?.duration ?? 0
				// if it's a still or irrelevant set it to 0
				duration = duration != 'N/A' && !mediaMeta.videoStill ? duration : 0
				// round to it 2dp
				mediaMeta.duration = Math.round(duration * 100) / 100
				
				mediaMeta.videoCodec = videoStream?.codec_name ?? ''
				mediaMeta.videoCodec = videoStream?.codec_name ?? ''
				mediaMeta.videoWidth = videoStream?.width ?? 0
				mediaMeta.videoHeight = videoStream?.height ?? 0
				mediaMeta.videoFormat = videoStream?.pix_fmt ?? ''

				// TODO: need to cross-reference list of possible alpha pixel formats...
				mediaMeta.videoAlpha = videoStream?.pix_fmt.includes('a') ?? false

				let FPS = videoStream?.r_frame_rate.split('/')[0] / videoStream?.r_frame_rate.split('/')[1]
				mediaMeta.videoFPS = (FPS && !mediaMeta.videoStill) ? Math.round(FPS * 100) / 100 : 0
				mediaMeta.videoBitRate = mediaMeta.video ? (videoStream.bit_rate != 'N/A' ? videoStream.bit_rate : 0) : 0

				mediaMeta.audio = audioStream !== undefined
				mediaMeta.audioCodec = audioStream?.codec_name ?? '',
				mediaMeta.audioSampleRate = audioStream?.sample_rate ?? 0,
				mediaMeta.audioChannels = audioStream?.channels ?? 0,
				mediaMeta.audioBitRate = audioStream?.bit_rate ?? 0

				try {
					await db.put(mediaMeta.fullPath, mediaMeta.all)
				}
				catch(err) {
					logger.warn("Failed to store cache for %s", mediaMeta.fullPath)
					logger.error("[%s] %s", err.name, err.message)
				}
				
				resolve(mediaMeta)
			}
		})
	})
}

/**
 * Work out if we're allowed a file based on the rules
 * @param {string} file file path to match
 * @param {object} rules object of arrays .includes & .excludes
 * @returns {boolean}
 */
export function isAllowed(file, rules) {
	// assume we're not allowed it
	let allowed = false

	if(rules.includes.length)
		// if we're being selective then it must match one of the allowed
		rules.includes.forEach(include => {
			if(file.match(include))
				allowed = true
		})
	else
		// otherwise everything goes
		allowed = true

	// unless it's not allowed in the excludes
	rules.excludes.forEach(exclude => {
		if(file.match(exclude))
			allowed = false
	})

	return allowed
}

/**
 * Wipe any of the existing metadata cache
 */
export function wipeCache() {
	db.clear()
}

/**
 * Deserialise an array of regular expressions (from the config)
 * @param {array} exps array of regular expressions
 * @returns {array} containing the Regex objectse
 */
export function deserialiseREArray(exps) {
	return exps.map((exp) => {
		const m = exp.match(/\/(.*)\/(.*)?/)
		return new RegExp(m[1], m[2] || "")
	})
}

/**
 * Create array of objects from Airtable view
 * @param {object} view AirTable view containing the fields & records to be returned
 * @param {object} defaults provide if you want to fill empty values
 * @returns {array} array of objects
 */
export async function airtableToArray(view, defaults = {}) {
	// get all rows
	const rows = await view.all()

	// return the id and fields from the fetched rows
	return rows.map(r => {
		return {
			id: r.id,
			fields: {...defaults, ...r.fields}
		}
	})
}

/**
 * Work out the differences between local and files on the web
 * @param {array} locals array of Metadata objects
 * @param {array} webs array of objects of dirs/files on AirTable (has ID)
 * @param {array} folderList array of objects of folders on AirTable (has ID)
 * @returns Object containing array of .inserts, .updates & .deletes
 */
export function checkDiffs(locals, webs, folderList = []) {
	// clone these as we are going to edit their contents
	locals = _.cloneDeep(locals)
	webs = _.cloneDeep(webs)

	let result = { updates: [] }

	locals.forEach((local, lIndex) => {
		const wIndex = webs.findIndex(web => local.fields._path == web.fields._path)

		const parentID = folderList.find(folder => folder.fields._path == local.parentPath)?.id
		if(parentID)
			local.parent = [parentID]

		if(wIndex > -1) {
			// found the same file on the web table
			if(!_.isEqual(local.fields, webs[wIndex].fields))
				// but the one on the web is different so add to the updates list
				result.updates.push({
					id: webs[wIndex].id,
					fields: local.fields
				})

			// remove this out of the local/web lists
			delete locals[lIndex]
			webs.splice(wIndex,1)
		}
	})

	// ones to insert are the ones that are only present locally
	result.inserts = locals.filter(el => el != null).map(el => el.fields)
	
	// ones to delete are the ones that are only present in the web list
	result.deletes = webs

	return result
}

/**
 * Update the AirTable table with the specified differences
 * @param {object} diffs object containing the .inserts, .updates & .deletes (from checkDiffs())
 * @param {object} table AirTable table object to update
 */
export async function updateAT(diffs, table, tableName, callback) {
	// store all the promises
	let proms = {
		inserts: [],
		updates: [],
		deletes: []
	}

	let result = {
		inserts: [],
		updates: [],
		deletes: 0
	}

	let error = ""

	// inserts
	for (let i = 0; i < diffs.inserts.length; i+=10) {
		// insert in blocks of 10
		proms.inserts.push(table.create(diffs.inserts.slice(i, i+10).map(r => {return {fields: r}})).then(records => {
			records.forEach(record => result.inserts.push(record.get('_path')))
		}))
	}
	
	for (let i = 0; i < diffs.updates.length; i+=10) {
		// update in blocks of 10
		proms.updates.push(table.update(diffs.updates.slice(i, i+10)).then(records => {
			records.forEach(record => result.updates.push(record.get('_path')))
		}))
	}

	for (let i = 0; i < diffs.deletes.length; i+=10) {
		// delete in blocks of 10
		proms.deletes.push(table.destroy(diffs.deletes.slice(i, i+10).map(r => r.id)).then((records) => {
			result.deletes += records.length
		}))
	}

	// if anything fails add it to the communal error
	Promise.all([...proms.inserts, ...proms.updates, ...proms.deletes]).catch(err => {
		if (err) {
			error += err + "\n"
		}
	})
	
	// wait for it to finish everything
	Promise.allSettled([...proms.inserts, ...proms.updates, ...proms.deletes]).then(r => callback(tableName, error, result))
}

import Airtable from 'airtable';

export async function sync(lists, config) {
	try {
		logger.debug('Initializing Airtable with config:', {
			base: config.base,
			foldersTable: config.foldersID,
			filesMetadataTable: config.filesMetadataID
		});

		const base = new Airtable({ apiKey: config.api }).base(config.base);
		const foldersTable = base(config.foldersID);
		const filesTable = base(config.filesMetadataID || config.filesID);

		// Sync folders
		if (lists.dirs.length > 0) {
			logger.debug(`Checking ${lists.dirs.length} folders for new entries`);
			for (const dir of lists.dirs) {
				// Check if folder already exists
				const existingFolders = await foldersTable.select({
					filterByFormula: `{_path} = '${dir.path}'`
				}).firstPage();

				if (existingFolders.length === 0) {
					await foldersTable.create({
						"_path": dir.path,
						"_fullPath": dir.path,
						"_ctime": dir.created,
						"_mtime": dir.modified
					});
					logger.debug(`Added new folder: ${dir.path}`);
				}
			}
		}

		// Sync files
		if (lists.files.length > 0) {
			logger.debug(`Checking ${lists.files.length} files for new entries`);
			for (const file of lists.files) {
				// Check if file already exists
				const existingFiles = await filesTable.select({
					filterByFormula: `{_path} = '${file.path}'`
				}).firstPage();

				if (existingFiles.length === 0) {
					const isPNG = file.type === 'png';
					const isMOV = file.type === 'mov';

					await filesTable.create({
						"_path": file.path,
						"_fullPath": file.path,
						"_size": file.size,
						"_ctime": file.created,
						"_mtime": file.modified,
						"_duration": file.duration,
						"_videoWidth": file.width,
						"_videoHeight": file.height,
						"_video": isMOV,
						"_videoStill": isPNG,
						"_audio": isMOV
					});
					logger.debug(`Added new file: ${file.path}`);
				}
			}
		}

		logger.info(`Sync complete - added only new entries`);
	} catch (error) {
		logger.error('Airtable sync error:', error);
		throw error;
	}
}

// Make sure we export all the functions
export default {
	rList,
	rLists,
	sync
};