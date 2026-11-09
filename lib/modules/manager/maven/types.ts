export interface MavenProp {
  val: string;
  fileReplacePosition: number;
  packageFile: string;
}

/** What the updateArtifacts step needs from a maven-lockfile `lockfile.json`. */
export interface MavenLockfileMetadata {
  lockFileVersion: number;
  mavenLockfileVersion?: string;
  hermetic: boolean;
}
