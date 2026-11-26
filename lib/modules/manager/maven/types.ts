import type { PackageFile } from '../types.ts';

export interface MavenProp {
  val: string;
  fileReplacePosition: number;
  packageFile: string;
}

export interface MavenInterimPackageFile extends PackageFile {
  mavenProps?: Record<string, any>;
  parent?: string;
}

/** What the updateArtifacts step needs from a maven-lockfile `lockfile.json`. */
export interface MavenLockfileMetadata {
  lockFileVersion: number;
  mavenLockfileVersion?: string;
  hermetic: boolean;
}
