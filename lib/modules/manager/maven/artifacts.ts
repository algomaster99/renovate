import { isNonEmptyString, isPlainObject } from '@sindresorhus/is';
import { quote } from 'shlex';
import upath from 'upath';
import { GlobalConfig } from '../../../config/global.ts';
import { TEMPORARY_ERROR } from '../../../constants/error-messages.ts';
import { logger } from '../../../logger/index.ts';
import { exec } from '../../../util/exec/index.ts';
import type { ExecOptions } from '../../../util/exec/types.ts';
import {
  privateCacheDir,
  readLocalFile,
  writeLocalFile,
} from '../../../util/fs/index.ts';
import { getFiles, getRepoStatus } from '../../../util/git/index.ts';
import { regEx } from '../../../util/regex.ts';
import { scm } from '../../platform/scm.ts';
import type {
  UpdateArtifact,
  UpdateArtifactsResult,
  Upgrade,
} from '../types.ts';
import { resolveToolConstraint } from '../util.ts';
import type { MavenLockfileMetadata } from './types.ts';

/**
 * Lock files written by https://github.com/chains-project/maven-lockfile.
 * The plugin writes one lock file per module, next to the module's pom.xml.
 */
export const MAVEN_LOCKFILE_PLUGIN = 'io.github.chains-project:maven-lockfile';
const LOCK_FILE_NAME = 'lockfile.json';

// The version ends up in `groupId:artifactId:version:goal`, so a `:` or any
// shell metacharacter from a hostile lock file must be rejected, not just quoted.
const safeVersionRegex = regEx(/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/);

/**
 * Detects a maven-lockfile lock file by content: `lockfile.json` is a generic
 * name, so require `lockFileVersion` and `metaData.config`.
 */
export function parseMavenLockfile(
  content: string | null,
): MavenLockfileMetadata | null {
  if (!content) {
    return null;
  }
  let json: any;
  try {
    json = JSON.parse(content);
  } catch {
    return null;
  }
  const config = json?.metaData?.config;
  if (typeof json?.lockFileVersion !== 'number' || !isPlainObject(config)) {
    return null;
  }
  return {
    lockFileVersion: json.lockFileVersion,
    mavenLockfileVersion: isNonEmptyString(config.mavenLockfileVersion)
      ? config.mavenLockfileVersion
      : undefined,
    hermetic: config.hermetic === true,
  };
}

export function isMavenExecutionAllowed(): boolean {
  const allowlist = GlobalConfig.get('allowedUnsafeExecutions');
  if (!allowlist.includes('maven')) {
    logger.once.warn(
      'Found maven-lockfile lock files, but `maven` is not permitted in allowedUnsafeExecutions',
    );
    return false;
  }
  return true;
}

/**
 * The topmost ancestor directory of the package file that holds both a
 * pom.xml and a lock file. Running there regenerates every module's lock
 * file, which a parent POM change needs.
 */
export function findReactorRoot(
  packageFileName: string,
  fileList: string[],
): string | null {
  const files = new Set(fileList);
  let root: string | null = null;
  let dir = upath.dirname(packageFileName);
  for (;;) {
    if (
      files.has(upath.join(dir, 'pom.xml')) &&
      files.has(upath.join(dir, LOCK_FILE_NAME))
    ) {
      root = dir;
    }
    if (dir === '.') {
      return root;
    }
    dir = upath.dirname(dir);
  }
}

function isLockFileUnder(root: string, fileName: string): boolean {
  if (upath.basename(fileName) !== LOCK_FILE_NAME) {
    return false;
  }
  return root === '.' || fileName.startsWith(`${root}/`);
}

/**
 * The lock file pins the plugin version that wrote it. If this update bumps
 * maven-lockfile itself, the new version must write the lock file instead.
 */
export function getPluginVersion(
  updatedDeps: Upgrade[],
  recordedVersion: string | undefined,
): string | undefined {
  const bump = updatedDeps.find(
    (dep) => (dep.packageName ?? dep.depName) === MAVEN_LOCKFILE_PLUGIN,
  );
  return bump?.newVersion ?? bump?.newValue ?? recordedVersion;
}

export async function updateArtifacts({
  packageFileName,
  updatedDeps,
  newPackageFileContent,
  config,
}: UpdateArtifact): Promise<UpdateArtifactsResult[] | null> {
  logger.debug(`maven.updateArtifacts(${packageFileName})`);

  const fileList = await scm.getFileList();
  const root = findReactorRoot(packageFileName, fileList);
  if (!root) {
    logger.debug('No maven-lockfile lock file found - skipping update');
    return null;
  }
  const rootPom = upath.join(root, 'pom.xml');
  const rootLockFile = upath.join(root, LOCK_FILE_NAME);

  if (config.isLockFileMaintenance && packageFileName !== rootPom) {
    logger.trace('Not the root pom.xml - skipping lock file maintenance');
    return null;
  }

  const lockFile = parseMavenLockfile(
    await readLocalFile(rootLockFile, 'utf8'),
  );
  if (!lockFile) {
    logger.debug(
      `${rootLockFile} is not a maven-lockfile lock file - skipping update`,
    );
    return null;
  }

  if (lockFile.hermetic) {
    // Hermetic lock files record artifacts resolved during a real build, which
    // `generate` alone cannot reproduce. Fail loudly instead of dropping them.
    return [
      {
        artifactError: {
          fileName: rootLockFile,
          stderr:
            'maven-lockfile hermetic lock files cannot be regenerated without a full build; update this lock file manually',
        },
      },
    ];
  }

  const version = getPluginVersion(updatedDeps, lockFile.mavenLockfileVersion);
  if (!version) {
    logger.warn(
      { lockFile: rootLockFile },
      'maven-lockfile lock file does not record mavenLockfileVersion - skipping update',
    );
    return null;
  }
  if (!safeVersionRegex.test(version)) {
    logger.warn(
      { lockFile: rootLockFile, version },
      'Invalid maven-lockfile version - skipping update',
    );
    return null;
  }

  if (!isMavenExecutionAllowed()) {
    return null;
  }

  logger.debug(`Regenerating maven-lockfile lock files with ${version}`);

  try {
    const lockFiles = fileList.filter((file) => isLockFileUnder(root, file));
    const oldLockFileContentMap = await getFiles(lockFiles);

    await writeLocalFile(packageFileName, newPackageFileContent);

    // Private cache: it is wiped between repositories, so artifacts fetched
    // with one repository's credentials never leak into another's build.
    const localRepo = upath.join(privateCacheDir(), 'maven-repository');
    const cmd = [
      'mvn',
      '--batch-mode',
      '--no-transfer-progress',
      `-Dmaven.repo.local=${localRepo}`,
      `${MAVEN_LOCKFILE_PLUGIN}:${version}:generate`,
    ]
      .map(quote)
      .join(' ');

    const execOptions: ExecOptions = {
      cwdFile: rootPom,
      docker: {},
      // No defaults from the lock file's `environment`: it records the machine
      // that last ran `generate` (often a CI runner), not what the project
      // needs. Users pin versions via the `constraints` config option.
      toolConstraints: [
        {
          toolName: 'java',
          constraint: await resolveToolConstraint(config, 'java'),
        },
        {
          toolName: 'maven',
          constraint: await resolveToolConstraint(config, 'maven'),
        },
      ],
    };
    await exec(cmd, { ...execOptions, ignoreStdout: true });

    const res: UpdateArtifactsResult[] = [];
    const status = await getRepoStatus();
    for (const modifiedFile of status.modified) {
      if (!isLockFileUnder(root, modifiedFile)) {
        continue;
      }
      const newContent = await readLocalFile(modifiedFile, 'utf8');
      if (oldLockFileContentMap[modifiedFile] !== newContent) {
        res.push({
          file: { type: 'addition', path: modifiedFile, contents: newContent },
        });
      }
    }
    return res.length ? res : null;
  } catch (err) {
    if (err.message === TEMPORARY_ERROR) {
      throw err;
    }
    logger.debug({ err }, 'Error while updating maven-lockfile lock files');
    return [
      {
        artifactError: {
          fileName: packageFileName,
          stderr: err.message,
        },
      },
    ];
  }
}
