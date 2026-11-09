import upath from 'upath';
import { envMock, mockExecAll } from '~test/exec-util.ts';
import { env, fs, git, logger, partial, scm } from '~test/util.ts';
import { GlobalConfig } from '../../../config/global.ts';
import type {
  InternalGlobalConfigOptions,
  RepoGlobalConfig,
} from '../../../config/types.ts';
import { TEMPORARY_ERROR } from '../../../constants/error-messages.ts';
import { ExecError } from '../../../util/exec/exec-error.ts';
import type { StatusResult } from '../../../util/git/types.ts';
import type { UpdateArtifact } from '../types.ts';
import {
  findReactorRoot,
  getPluginVersion,
  parseMavenLockfile,
} from './artifacts.ts';
import { updateArtifacts } from './index.ts';

vi.mock('../../../util/fs/index.ts');
vi.mock('../../../util/exec/env.ts');

const adminConfig: RepoGlobalConfig & InternalGlobalConfigOptions = {
  localDir: upath.join('/tmp/github/some/repo'),
  cacheDir: upath.join('/tmp/cache'),
  allowedUnsafeExecutions: ['maven'],
  binarySource: 'global',
};

function lockfile(
  config: Record<string, unknown> = { mavenLockfileVersion: '5.18.8' },
): string {
  return JSON.stringify({
    lockFileVersion: 1,
    metaData: {
      environment: { mavenVersion: '3.9.15', javaVersion: '17.0.21' },
      config,
    },
  });
}

function generateCmd(version: string): string {
  return `mvn --batch-mode --no-transfer-progress -Dmaven.repo.local=/tmp/cache/private/maven-repository io.github.chains-project:maven-lockfile:${version}:generate`;
}

function input(overrides: Partial<UpdateArtifact> = {}): UpdateArtifact {
  return {
    packageFileName: 'pom.xml',
    updatedDeps: [{ depName: 'org.example:lib', newValue: '2.0.0' }],
    newPackageFileContent: '<project/>',
    config: {},
    ...overrides,
  };
}

describe('modules/manager/maven/artifacts', () => {
  let lockFiles: Record<string, string>;

  beforeEach(() => {
    env.getChildProcessEnv.mockReturnValue(envMock.basic);
    GlobalConfig.set(adminConfig);
    fs.privateCacheDir.mockReturnValue('/tmp/cache/private');

    lockFiles = { 'lockfile.json': lockfile() };
    scm.getFileList.mockResolvedValue(['pom.xml', 'lockfile.json']);
    fs.readLocalFile.mockImplementation((name: string) =>
      Promise.resolve(lockFiles[name] ?? null),
    );
    git.getFiles.mockResolvedValue({ 'lockfile.json': 'old' });
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({ modified: ['pom.xml', 'lockfile.json'] }),
    );
  });

  describe('parseMavenLockfile', () => {
    it('reads plugin version and hermetic flag', () => {
      expect(
        parseMavenLockfile(
          lockfile({ mavenLockfileVersion: '5.18.8', hermetic: true }),
        ),
      ).toEqual({
        lockFileVersion: 1,
        mavenLockfileVersion: '5.18.8',
        hermetic: true,
      });
    });

    it.each`
      content
      ${null}
      ${'not json'}
      ${'{"lockfileVersion": 1}'}
      ${'{"lockFileVersion": 1, "dependencies": []}'}
    `('rejects $content', ({ content }) => {
      expect(parseMavenLockfile(content)).toBeNull();
    });
  });

  describe('findReactorRoot', () => {
    const files = [
      'pom.xml',
      'lockfile.json',
      'core/pom.xml',
      'core/lockfile.json',
      'core/nested/pom.xml',
      'core/nested/lockfile.json',
      'standalone/pom.xml',
      'standalone/sub/pom.xml',
      'standalone/sub/lockfile.json',
    ];

    it.each`
      packageFile                 | root
      ${'pom.xml'}                | ${'.'}
      ${'core/nested/pom.xml'}    | ${'.'}
      ${'.mvn/extensions.xml'}    | ${'.'}
      ${'standalone/sub/pom.xml'} | ${'.'}
      ${'standalone/sub/x/a.xml'} | ${'.'}
    `('$packageFile -> $root', ({ packageFile, root }) => {
      expect(findReactorRoot(packageFile, files)).toBe(root);
    });

    it('stops at the topmost directory with a lock file', () => {
      expect(findReactorRoot('standalone/sub/pom.xml', files.slice(2))).toBe(
        'standalone/sub',
      );
    });

    it('returns null without a lock file', () => {
      expect(findReactorRoot('pom.xml', ['pom.xml'])).toBeNull();
    });
  });

  describe('getPluginVersion', () => {
    it('uses the recorded version', () => {
      expect(getPluginVersion([{ depName: 'a:b' }], '5.18.8')).toBe('5.18.8');
    });

    it('prefers the version this update bumps maven-lockfile to', () => {
      expect(
        getPluginVersion(
          [
            {
              depName: 'io.github.chains-project:maven-lockfile',
              newValue: '5.19.0',
            },
          ],
          '5.18.8',
        ),
      ).toBe('5.19.0');
    });
  });

  describe('updateArtifacts', () => {
    it('returns null when the repository has no lock file', async () => {
      scm.getFileList.mockResolvedValue(['pom.xml']);
      const execSnapshots = mockExecAll();

      await expect(updateArtifacts(input())).resolves.toBeNull();
      expect(execSnapshots).toEqual([]);
    });

    it('returns null when lockfile.json is not a maven-lockfile lock file', async () => {
      lockFiles['lockfile.json'] = '{"name": "something else"}';
      const execSnapshots = mockExecAll();

      await expect(updateArtifacts(input())).resolves.toBeNull();
      expect(execSnapshots).toEqual([]);
    });

    it('regenerates with the recorded plugin version', async () => {
      const execSnapshots = mockExecAll();
      fs.readLocalFile.mockImplementation((name: string) =>
        Promise.resolve(
          name === 'lockfile.json' && execSnapshots.length
            ? 'new'
            : (lockFiles[name] ?? null),
        ),
      );

      await expect(updateArtifacts(input())).resolves.toEqual([
        {
          file: { type: 'addition', path: 'lockfile.json', contents: 'new' },
        },
      ]);
      expect(fs.writeLocalFile).toHaveBeenCalledWith('pom.xml', '<project/>');
      expect(execSnapshots).toMatchObject([
        {
          cmd: generateCmd('5.18.8'),
          options: { cwd: '/tmp/github/some/repo' },
        },
      ]);
    });

    it('regenerates every module from the root when a module pom changes', async () => {
      scm.getFileList.mockResolvedValue([
        'pom.xml',
        'lockfile.json',
        'core/pom.xml',
        'core/lockfile.json',
        'other/lockfile.json.bak',
      ]);
      git.getFiles.mockResolvedValue({
        'lockfile.json': 'old',
        'core/lockfile.json': 'old',
      });
      git.getRepoStatus.mockResolvedValue(
        partial<StatusResult>({
          modified: ['core/pom.xml', 'lockfile.json', 'core/lockfile.json'],
        }),
      );
      const execSnapshots = mockExecAll();
      fs.readLocalFile.mockImplementation((name: string) =>
        Promise.resolve(
          execSnapshots.length ? `new ${name}` : (lockFiles[name] ?? null),
        ),
      );

      const res = await updateArtifacts(
        input({ packageFileName: 'core/pom.xml' }),
      );

      expect(git.getFiles).toHaveBeenCalledWith([
        'lockfile.json',
        'core/lockfile.json',
      ]);
      expect(res?.map((r) => r.file?.path)).toEqual([
        'lockfile.json',
        'core/lockfile.json',
      ]);
      expect(execSnapshots).toMatchObject([
        { options: { cwd: '/tmp/github/some/repo' } },
      ]);
    });

    it('uses the new version when the update bumps maven-lockfile itself', async () => {
      const execSnapshots = mockExecAll();

      await updateArtifacts(
        input({
          updatedDeps: [
            {
              depName: 'io.github.chains-project:maven-lockfile',
              newValue: '5.19.0',
            },
          ],
        }),
      );

      expect(execSnapshots).toMatchObject([{ cmd: generateCmd('5.19.0') }]);
    });

    it('returns null when nothing changed', async () => {
      git.getFiles.mockResolvedValue({ 'lockfile.json': lockfile() });
      mockExecAll();

      await expect(updateArtifacts(input())).resolves.toBeNull();
    });

    it('fails loudly for hermetic lock files', async () => {
      lockFiles['lockfile.json'] = lockfile({
        mavenLockfileVersion: '5.18.8',
        hermetic: true,
      });
      const execSnapshots = mockExecAll();

      await expect(updateArtifacts(input())).resolves.toEqual([
        {
          artifactError: {
            fileName: 'lockfile.json',
            stderr: expect.stringContaining('hermetic'),
          },
        },
      ]);
      expect(execSnapshots).toEqual([]);
    });

    it('skips lock files that do not record the plugin version', async () => {
      lockFiles['lockfile.json'] = lockfile({});
      const execSnapshots = mockExecAll();

      await expect(updateArtifacts(input())).resolves.toBeNull();
      expect(execSnapshots).toEqual([]);
      expect(logger.logger.warn).toHaveBeenCalledWith(
        { lockFile: 'lockfile.json' },
        expect.stringContaining('mavenLockfileVersion'),
      );
    });

    it('rejects a version that could change the command', async () => {
      lockFiles['lockfile.json'] = lockfile({
        mavenLockfileVersion: '5.18.8:evil',
      });
      const execSnapshots = mockExecAll();

      await expect(updateArtifacts(input())).resolves.toBeNull();
      expect(execSnapshots).toEqual([]);
    });

    it('does not run mvn unless allowed by allowedUnsafeExecutions', async () => {
      GlobalConfig.set({ ...adminConfig, allowedUnsafeExecutions: [] });
      const execSnapshots = mockExecAll();

      await expect(updateArtifacts(input())).resolves.toBeNull();
      expect(execSnapshots).toEqual([]);
    });

    it('runs lock file maintenance only from the root pom', async () => {
      scm.getFileList.mockResolvedValue([
        'pom.xml',
        'lockfile.json',
        'core/pom.xml',
        'core/lockfile.json',
      ]);
      const execSnapshots = mockExecAll();

      await expect(
        updateArtifacts(
          input({
            packageFileName: 'core/pom.xml',
            updatedDeps: [],
            config: { isLockFileMaintenance: true },
          }),
        ),
      ).resolves.toBeNull();
      expect(execSnapshots).toEqual([]);
    });

    it('returns an artifact error when mvn fails', async () => {
      mockExecAll(
        new ExecError('mvn failed', {
          cmd: '',
          stdout: '',
          stderr: '',
          options: {},
        }),
      );

      await expect(updateArtifacts(input())).resolves.toEqual([
        { artifactError: { fileName: 'pom.xml', stderr: 'mvn failed' } },
      ]);
    });

    it('rethrows temporary errors', async () => {
      mockExecAll(new Error(TEMPORARY_ERROR));

      await expect(updateArtifacts(input())).rejects.toThrow(TEMPORARY_ERROR);
    });
  });
});
