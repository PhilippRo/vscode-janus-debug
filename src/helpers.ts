﻿'use strict';

import * as fs from 'fs';
import * as nodeDoc from 'node-documents-scripting';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

// tslint:disable-next-line:no-var-requires
const reduce = require('reduce-for-promises');
// tslint:disable-next-line:no-var-requires
const winattr = require('winattr');

// like eclipse plugin
export const COMPARE_FOLDER = '.compare';
export const COMPARE_FILE_PREFIX = 'compare_';

const FORCE_UPLOAD_YES = 'Yes';
const FORCE_UPLOAD_NO = 'No';
const FORCE_UPLOAD_ALL = 'Yes (remember my answer for this operation)';
const FORCE_UPLOAD_NONE = 'No (remember my answer for this operation)';
const NO_CONFLICT = 'No conflict';

export const CACHE_FILE = '.vscode-janus-debug';
const SCRIPT_NAMES_FILE = '.documents-script-names';

export enum autoUploadAnswer {
    yes,
    no,
    never
}

/**
 * Extends an object with another object's properties.
 *
 * Merges the properties of two objects together into the first object.
 *
 * @param target The object that will receive source's properties.
 * @param source An object carrying additional properties.
 */
export function extend<T, U>(target: T, source: U): T & U {
    const s: any = source;
    const t: any = target;
    Object.keys(s).forEach(key => t[key] = s[key]);
    return t;
}

/**
 * Subfunction of ensureUploadScripts.
 *
 * @param script
 * @param all
 * @param none
 */
export async function askForUpload(script: nodeDoc.scriptT, all: boolean, none: boolean, singlescript?: boolean): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        if (script.conflict || !script.lastSyncHash) {
            if (all) {
                resolve(FORCE_UPLOAD_ALL);
            } else if (none) {
                resolve(FORCE_UPLOAD_NONE);
            } else {
                let question;
                if (script.lastSyncHash) {
                    question = `${script.name} has been changed on server, upload anyway?`;
                } else {
                    question = `${script.name} might have been changed on server, upload anyway?`;
                }
                let answers = [FORCE_UPLOAD_YES, FORCE_UPLOAD_NO];
                if (!singlescript) {
                    answers = [FORCE_UPLOAD_YES, FORCE_UPLOAD_NO, FORCE_UPLOAD_ALL, FORCE_UPLOAD_NONE];
                }
                return vscode.window.showQuickPick(answers, { placeHolder: question }).then((value) => {
                    resolve(value);
                });
            }
        } else {
            resolve(NO_CONFLICT);
        }
    });
}

/**
 * Ask user for all conflicted scripts if they should be force uploaded or if upload should
 * be cancelled
 *
 * @param param List of potentially conflicted scripts.
 *
 * @return Two arrays containing scripts of input array.
 * 1. arrray: scripts that are already uploaded 2. array: scripts that user marked to force upload.
 */
export async function ensureForceUpload(scripts: nodeDoc.scriptT[]): Promise<[nodeDoc.scriptT[], nodeDoc.scriptT[]]> {
    return new Promise<[nodeDoc.scriptT[], nodeDoc.scriptT[]]>((resolve, reject) => {
        const forceUpload: nodeDoc.scriptT[] = [];
        const noConflict: nodeDoc.scriptT[] = [];
        let all = false;
        let none = false;
        const singlescript = (1 === scripts.length);

        return reduce(scripts, (numScripts: number, script: any): Promise<number> => {
            return askForUpload(script, all, none, singlescript).then((value) => {
                if (NO_CONFLICT === value) {
                    noConflict.push(script);
                } else if (FORCE_UPLOAD_ALL === value) {
                    script.forceUpload = true;
                    script.conflict = false;
                    forceUpload.push(script);
                    all = true;
                } else if (FORCE_UPLOAD_YES === value) {
                    script.forceUpload = true;
                    script.conflict = false;
                    forceUpload.push(script);
                } else if (FORCE_UPLOAD_NO === value) {
                    // do nothing ...
                } else {
                    // escape or anything should behave like 'None'
                    none = true;
                }
                return numScripts + 1;
            });
        }, 0).then(() => {
            resolve([noConflict, forceUpload]);
        });
    });
}

/**
 * Read from settings.json if the script must be uploaded.
 * If it's not set, ask user, if the script should be uploaded and if
 * the answer should be saved. If so, save it to settings.json.
 *
 * @param param script-name or -path
 */
export async function ensureUploadOnSave(param: string): Promise<autoUploadAnswer> {
    return new Promise<autoUploadAnswer>((resolve, reject) => {
        let always: string[] = [];
        let never: string[] = [];

        // get extension-part of settings.json
        const conf = vscode.workspace.getConfiguration('vscode-janus-debug');

        if (!vscode.workspace || !param || 0 === param.length || !conf) {
            return reject('something is undefined');
        }

        const scriptname = path.basename(param, '.js');

        const _always = conf.get('uploadOnSave');
        const _never = conf.get('uploadManually');
        if (_always instanceof Array && _never instanceof Array) {
            always = _always;
            never = _never;
        } else {
            vscode.window.showWarningMessage('Cannot read upload mode from settings.json');
            return reject();
        }
        if (0 <= never.indexOf(scriptname)) {
            resolve(autoUploadAnswer.no);
        } else if (0 <= always.indexOf(scriptname)) {
            resolve(autoUploadAnswer.yes);
        } else {
            const QUESTION: string = `Upload script ${scriptname}?`;
            const YES: string = `Yes`;
            const NO: string = `No`;
            const ALWAYS: string = `Always upload ${scriptname} automatically`;
            const NEVER: string = `Never upload ${scriptname} automatically`;
            const NEVERASK: string = `Never upload automatically`;
            vscode.window.showQuickPick([YES, NO, ALWAYS, NEVER, NEVERASK], { placeHolder: QUESTION }).then((answer) => {
                if (YES === answer) {
                    resolve(autoUploadAnswer.yes);
                } else if (NO === answer) {
                    resolve(autoUploadAnswer.no);
                } else if (ALWAYS === answer) {
                    always.push(scriptname);
                    conf.update('uploadOnSave', always);
                    resolve(autoUploadAnswer.yes);
                } else if (NEVER === answer) {
                    never.push(scriptname);
                    conf.update('uploadManually', never);
                    resolve(autoUploadAnswer.no);
                } else if (NEVERASK === answer) {
                    conf.update('uploadOnSaveGlobal', false, true);
                    resolve(autoUploadAnswer.never);
                }
            });
        }
    });
}


/**
 * Read list downloadScriptNames
 */
export function getDownloadScriptNamesFromList(): nodeDoc.scriptT[] {
    let scriptnames: string[];
    let scripts: nodeDoc.scriptT[];

    if (!vscode.workspace || !vscode.workspace.rootPath) {
        return [];
    }

    try {
        const file = path.join(vscode.workspace.rootPath, SCRIPT_NAMES_FILE);
        scriptnames = fs.readFileSync(file, 'utf8').trim().split(os.EOL);
    } catch (err) {
        return [];
    }


    // get scriptnames and insert in return list
    scripts = [];
    if (scriptnames instanceof Array && 0 < scriptnames.length) {
        scriptnames.forEach((scriptname) => {
            scripts.push(new nodeDoc.scriptT(scriptname.trim()));
        });
    }

    return scripts;
}

export function writeScriptNamesToFile(scripts: nodeDoc.scriptT[]) {
    if (!vscode.workspace || !vscode.workspace.rootPath) {
        return;
    }
    if (!scripts || 0 === scripts.length) {
        return;
    }

    // get scriptnames
    const scriptnames: string[] = [];
    scripts.forEach((script) => {
        scriptnames.push(script.name);
    });

    const scriptnamesstr = scriptnames.join(os.EOL) + os.EOL;
    const file = path.join(vscode.workspace.rootPath, SCRIPT_NAMES_FILE);
    fs.writeFileSync(file, scriptnamesstr);

    vscode.workspace.openTextDocument(vscode.Uri.file(file)).then((doc) => {
        vscode.window.showTextDocument(doc);
    });
}


export function setCategories(pscripts: nodeDoc.scriptT[]) {
    if (!pscripts || 0 === pscripts.length || !vscode.workspace) {
        return;
    }

    // get extension-part of settings.json
    const conf = vscode.workspace.getConfiguration('vscode-janus-debug');
    if (!conf) {
        vscode.window.showWarningMessage('Cannot read from settings.json');
        return;
    }
    const categories = conf.get('categories', false);

    if (categories) {
        pscripts.forEach((script) => {
            if (script.path) {
                let scriptDir = '';
                if (fs.statSync(script.path).isDirectory()) {
                    scriptDir = path.normalize(script.path);
                } else if (fs.statSync(script.path).isFile()) {
                    scriptDir = path.dirname(path.normalize(script.path));
                }
                script.category = scriptDir.split(path.sep).pop();
            }
        });
    }
}

export function setCategoryRoots(pscripts: nodeDoc.scriptT[], contextMenuPath: string | undefined, scriptDir: string) {
    console.log('setCategoryRoots');

    if (!pscripts || 0 === pscripts.length || !vscode.workspace) {
        return;
    }

    // no folders from category should be created, if command
    // 'downloadScript' is called on file context menu
    if (contextMenuPath && fs.statSync(contextMenuPath).isFile()) {
        return;
    }

    // get extension-part of settings.json
    const conf = vscode.workspace.getConfiguration('vscode-janus-debug');
    if (!conf) {
        vscode.window.showWarningMessage('Cannot read from settings.json');
        return;
    }

    // get category flag
    const categories = conf.get('createFoldersFromCategories', false);

    if (categories) {
        pscripts.forEach((script) => {
            if (fs.statSync(scriptDir).isDirectory()) {
                script.categoryRoot = path.normalize(scriptDir);
            } else if (fs.statSync(scriptDir).isFile()) {
                script.categoryRoot = path.dirname(path.normalize(scriptDir));
            }
        });
    }
}


export function readEncryptionFlag(pscripts: nodeDoc.scriptT[]) {
    if (!pscripts || 0 === pscripts.length || !vscode.workspace) {
        return;
    }

    // get extension-part of settings.json
    const conf = vscode.workspace.getConfiguration('vscode-janus-debug');
    if (!conf) {
        vscode.window.showWarningMessage('Cannot read from settings.json');
        return;
    }

    // write values
    const encryptOnUpload = conf.get('encryptOnUpload');
    if (encryptOnUpload) {
        pscripts.forEach((script) => {
            script.encrypted = 'decrypted';
        });
    } else {
        pscripts.forEach((script) => {
            script.encrypted = 'false';
        });
    }
}



export function readConflictModes(pscripts: nodeDoc.scriptT[]) {
    if (!pscripts || 0 === pscripts.length) {
        return;
    }
    if (!vscode.workspace) {
        return;
    }

    // get extension-part of settings.json
    const conf = vscode.workspace.getConfiguration('vscode-janus-debug');

    const _forceUpload = conf.get('forceUpload');
    let forceUpload: string[];
    if (_forceUpload instanceof Array) {
        forceUpload = _forceUpload;
    } else {
        vscode.window.showWarningMessage('Cannot write to settings.json');
        return;
    }

    // read values
    pscripts.forEach((script) => {
        if (0 <= forceUpload.indexOf(script.name)) {
            script.conflictMode = false;
        }
    });
}

/**
 * Reads the conflict mode and hash value of any script in pscripts.
 */
export function readHashValues(pscripts: nodeDoc.scriptT[], server: string) {
    if (!pscripts || 0 === pscripts.length) {
        return;
    }

    if (!vscode.workspace || !vscode.workspace.rootPath) {
        return;
    }

    // filename of cache file CACHE_FILE
    const _documents = path.join(vscode.workspace.rootPath, CACHE_FILE);

    // get hash values from file as array
    let hashValues: string[];
    try {
        hashValues = fs.readFileSync(_documents, 'utf8').trim().split('\n');
    } catch (err) {
        if (err.code === 'ENOENT') {
            hashValues = [];
            fs.writeFileSync(_documents, '');
        } else {
            return;
        }
    }

    // get extension-part of settings.json
    const conf = vscode.workspace.getConfiguration('vscode-janus-debug');

    // get the list of scripts in conflict mode
    const _forceUpload = conf.get('forceUpload');
    let forceUpload: string[];
    if (_forceUpload instanceof Array) {
        forceUpload = _forceUpload;
    } else {
        vscode.window.showWarningMessage('Cannot write to settings.json');
        return;
    }

    // read hash values of scripts in conflict mode
    pscripts.forEach((script) => {
        if (0 <= forceUpload.indexOf(script.name)) {
            script.conflictMode = false;
        } else {
            hashValues.forEach((value, idx) => {
                const scriptpart = value.split(':')[0];
                const scriptAtServer = script.name + '@' + server;

                if (scriptpart === scriptAtServer) {
                    script.lastSyncHash = hashValues[idx].split(':')[1];
                }
            });
        }
    });
}

export function updateHashValues(pscripts: nodeDoc.scriptT[], server: string) {
    if (!pscripts || 0 === pscripts.length) {
        return;
    }
    if (!vscode.workspace || !vscode.workspace.rootPath) {
        return;
    }

    // filename of cache file CACHE_FILE
    const _documents = path.join(vscode.workspace.rootPath, CACHE_FILE);

    let hashValues: string[];
    try {
        // get hash values from file as array
        hashValues = fs.readFileSync(_documents, 'utf8').trim().split('\n');
    } catch (err) {
        // todo
        // if (err.code === 'ENOENT') {
        //     hashValues = [];
        //     fs.writeFileSync(_documents, '');
        // } else {
        //     return;
        // }

        return;
    }

    // get extension-part of settings.json
    const conf = vscode.workspace.getConfiguration('vscode-janus-debug');

    // get the list of scripts in conflict mode
    const _forceUpload = conf.get('forceUpload');
    let forceUpload: string[];
    if (_forceUpload instanceof Array) {
        forceUpload = _forceUpload;
    } else {
        vscode.window.showWarningMessage('Cannot write to settings.json');
        return;
    }

    // set hash values of scripts in conflict mode
    pscripts.forEach((script) => {
        // todo docu why (true !== script.conflict)
        if (0 > forceUpload.indexOf(script.name) && true !== script.conflict) {
            const scriptAtServer = script.name + '@' + server;
            const entry = scriptAtServer + ':' + script.lastSyncHash;

            // search entry
            let updated = false;
            hashValues.forEach((value, idx) => {
                const scriptpart = value.split(':')[0];
                if (scriptpart === scriptAtServer) {
                    hashValues[idx] = entry;
                    updated = true;
                }
            });

            // create new entry
            if (!updated) {
                hashValues.push(entry);
            }
        }
    });

    // write to CACHE_FILE
    const hashValStr = hashValues.join('\n').trim();
    nodeDoc.writeFile(hashValStr, _documents);
}

export function compareScript(_path: string, scriptname: string): void {
    if (!vscode.workspace.rootPath || !vscode.workspace.rootPath) {
        return;
    }

    if (!_path || !scriptname) {
        vscode.window.showErrorMessage('Select or open a file to compare');
        return;
    } else {
        const leftfile = path.join(vscode.workspace.rootPath, COMPARE_FOLDER, COMPARE_FILE_PREFIX + scriptname + '.js');
        const rightfile = path.join(_path, scriptname + '.js');
        const lefturi = vscode.Uri.file(leftfile);
        const righturi = vscode.Uri.file(rightfile);
        const title = scriptname + '.js' + ' (DOCUMENTS Server)';

        vscode.commands.executeCommand('vscode.diff', lefturi, righturi, title).then(() => {
            /* ... */
        }, (reason) => {
            vscode.window.showErrorMessage('Compare script failed ' + reason);
        });
    }
}

export async function createFolder(_path: string, hidden = false): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        fs.stat(_path, (err, stats) => {
            if (err) {
                if ('ENOENT' === err.code) {
                    fs.mkdir(_path, (error) => {
                        if (error) {
                            reject(error);
                        } else {
                            if (hidden) {
                                winattr.set(_path, { hidden: true }, (reason: any) => {
                                    if (reason) {
                                        reject(reason);
                                    } else {
                                        resolve();
                                    }
                                });
                            } else {
                                resolve();
                            }
                        }
                    });
                } else {
                    reject(err);
                }
            } else {
                if (stats.isDirectory()) {
                    resolve();
                } else {
                    reject(`${_path} already exists but is not a directory`);
                }
            }
        });
    });
}

/**
 * Returns [folder:string], if fileOrFolder is a folder and
 * [folder:string, file:string] if fileOrFolder is a file.
 */
export async function checkPath(fileOrFolder: string, allowCreateFolder = false): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
        fs.stat(fileOrFolder, function(err1, stats1) {

            if (err1) {
                if (allowCreateFolder && 'ENOENT' === err1.code && 'js' !== path.extname(fileOrFolder)) {
                    const p = fileOrFolder.split(path.sep);
                    const newfolder = p.pop();
                    const _path = p.join(path.sep);
                    fs.stat(_path, (err2, stats2) => {
                        if (err2) {
                            if ('ENOENT' === err2.code) {
                                reject('can only create a single subfolder on a valid path');
                            } else {
                                reject(err2.message);
                            }
                        } else {
                            if (stats2.isDirectory()) {
                                if (newfolder) {
                                    resolve([path.join(_path, newfolder)]);
                                } else {
                                    reject('path is empty');
                                }
                            } else {
                                reject('can only create a single subfolder on a valid path');
                            }
                        }
                    });
                } else {
                    reject(err1.message);
                }
            } else {
                if (stats1.isDirectory()) {
                    resolve([fileOrFolder]);
                } else if (stats1.isFile()) {
                    resolve([path.dirname(fileOrFolder), path.basename(fileOrFolder, '.js')]);
                } else {
                    reject('unexpected error in ' + fileOrFolder);
                }
            }
        });
    });
}

/**
 * Returns [folder], if fileOrFolder is a folder and [folder, file] if fileOrFolder is a file.
 */
export async function ensurePath(fileOrFolder: string | undefined, allowSubDir = false, withBaseName = false): Promise<string[]> {
    console.log('ensurePathInput');

    if (!vscode.workspace || !vscode.workspace.rootPath) {
        return [];
    }

    const workspaceFolder = vscode.workspace.rootPath;

    return new Promise<string[]>((resolve, reject) => {

        // given path must be absolute
        if (fileOrFolder) {

            // if there's a workspace, returned path must be a subfolder of rootPath
            if (!vscode.workspace || fileOrFolder.toLowerCase().startsWith(workspaceFolder.toLowerCase())) {

                // check folder and get folder from file
                checkPath(fileOrFolder).then((retpath) => {
                    resolve(retpath);
                }).catch((reason) => {
                    reject(reason);
                });

            } else {
                reject(fileOrFolder + ' is not a subfolder of ' + vscode.workspace.rootPath);
            }
        } else {

            // set default path
            let defaultPath = '';
            if (vscode.window.activeTextEditor) {
                if (withBaseName) {
                    defaultPath = vscode.window.activeTextEditor.document.fileName;
                } else {
                    defaultPath = path.dirname(vscode.window.activeTextEditor.document.fileName);
                }
            } else if (vscode.workspace && !withBaseName) {
                defaultPath = workspaceFolder;
            }

            // ask for path
            const _promt = withBaseName ? 'Please enter the script' : 'Please enter the folder';
            vscode.window.showInputBox({
                prompt: _promt,
                value: defaultPath,
                ignoreFocusOut: true,
            }).then((input) => {

                // input path must be absolute
                if (input) {

                    // if there's a workspace, returned path must be subfolder of rootPath
                    if (!vscode.workspace || input.toLowerCase().startsWith(workspaceFolder.toLowerCase())) {

                        // check folder and get folder from file
                        checkPath(input, allowSubDir).then((retpath) => {
                            resolve(retpath);
                        }).catch((reason) => {
                            reject(reason);
                        });
                    } else {
                        reject(input + ' is not a subfolder of ' + workspaceFolder);
                    }
                } else {
                    reject('no path');
                }
            });
        }
    });
}

export async function ensureScriptName(paramscript?: string): Promise<string> {
    console.log('ensureScriptName');
    return new Promise<string>((resolve, reject) => {

        if (paramscript && '.js' === path.extname(paramscript)) {
            resolve(path.basename(paramscript, '.js'));

        } else {
            let activeScript = '';
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                activeScript = path.basename(editor.document.fileName, '.js');
            }
            vscode.window.showInputBox({
                prompt: 'Please enter the script name or path',
                value: activeScript,
                ignoreFocusOut: true,
            }).then((_scriptname) => {
                if (_scriptname) {
                    resolve(path.basename(_scriptname, '.js'));
                } else {
                    reject('no script');
                }
            });
        }
    });
}

/**
 * Return script of type scriptT containing name and source code of given path or textdocument.
 *
 * @param param path to script or textdocument of script
 */
export async function ensureScript(param?: string | vscode.TextDocument): Promise<nodeDoc.scriptT> {
    console.log('ensureScript');
    return new Promise<nodeDoc.scriptT>((resolve, reject) => {

        if (param) {
            if (typeof param === 'string') {
                // param: path to script
                const retscript = nodeDoc.getScript(param);
                if (retscript instanceof nodeDoc.scriptT) {
                    retscript.path = param;
                    resolve(retscript);
                } else {
                    reject(retscript);
                }

            } else { // param: vscode.TextDocument
                const ret: nodeDoc.scriptT = new nodeDoc.scriptT(path.basename(param.fileName, '.js'), param.fileName, param.getText());
                resolve(ret);
            }
        } else {
            let activeScript = '';
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                activeScript = editor.document.fileName;
            }
            vscode.window.showInputBox({
                prompt: 'Please enter the script name or path',
                value: activeScript,
                ignoreFocusOut: true,
            }).then((_scriptname) => {
                if (_scriptname) {
                    const retscript = nodeDoc.getScript(_scriptname);
                    if (retscript instanceof nodeDoc.scriptT) {
                        retscript.path = param;
                        resolve(retscript);
                    } else {
                        reject(retscript);
                    }
                } else {
                    reject('no scriptname');
                }
            });

        }
    });
}

export function showWarning(loginData: nodeDoc.LoginData) {
    if (0 < loginData.lastWarning.length) {
        vscode.window.showWarningMessage(loginData.lastWarning);
        loginData.lastWarning = '';
    }
}
