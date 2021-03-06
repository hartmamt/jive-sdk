/*
 * Copyright 2013 Jive Software
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 */

var fs = require('fs'),
    q  = require('q'),
    path  = require('path'),
    jive = require('../api'),
    service = require('./service');

var express = require('express');
var consolidate = require('consolidate');

var baseSetup = require('./baseSetup');
var definitionSetup = Object.create(baseSetup);
module.exports = definitionSetup;

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Private

function isValidFile(file ) {
    return !(file.indexOf('.') == 0)
}

function fsexists(path) {
    var deferred = q.defer();
    var method = fs.exists ? fs.exists : require('path').exists;
    method( path, function(exists ) {
        deferred.resolve(exists);
    });

    return deferred.promise;
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// public

/**
 * Returns a promise when defintion tasks, life cycle events,
 * and other things in the service directory have been processed.
 * @param definitionName
 * @param svcDir
 * @return {*}
 */
definitionSetup.setupDefinitionServices = function( app, definitionName, svcDir ) {
    /////////////////////////////////////////////////////
    // apply definition specific tasks, life cycle events, etc.

    function setupDefinitionEventListener(handlerInfo, definitionName) {
        if (!handlerInfo['event']) {
            throw new Error('Event handler for tile definition "'
                + definitionName + '" must specify an event name.');
        }
        if (!handlerInfo['handler']) {
            throw new Error('Event handler for tile definition "'
                + definitionName + '" must specify a function handler.');
        }

        if (jive.events.globalEvents.indexOf(handlerInfo['event']) != -1) {
            jive.events.addSystemEventListener(handlerInfo['event'], handlerInfo['handler']);
        } else {
            jive.events.addDefinitionEventListener(
                handlerInfo['event'],
                definitionName,
                handlerInfo['handler'],
                handlerInfo['description'] || 'Unique to definition'
            );
        }
    }

    return definitionSetup.setupServices(app, definitionName, svcDir, setupDefinitionEventListener);
};

/**
 * Returns a promise when all the routes have been calculated for a particular definition directory.
 */
definitionSetup.setupDefinitionRoutes = function(app, definitionName, routesPath){
    return definitionSetup.setupRoutes( app, definitionName, routesPath );
};

definitionSetup.setupDefinitionMetadata = function(definitionPath) {
    // if a definition exists, read it from disk and save it
    return fsexists(definitionPath).then( function(exists) {
        if ( exists ) {
            return q.nfcall( fs.readFile, definitionPath).then( function(data ) {
                var definitionDirName = path.basename( path.dirname( definitionPath ) );
                var definition = JSON.parse(data);
                definition.id = definition.id === '{{{definition_id}}}' ? null : definition.id;
                definition['definitionDirName'] = definitionDirName;
                return definition;
            }).then( function( definition ) {
                var apiToUse = definition['style'] === 'ACTIVITY' ?  jive.extstreams.definitions : jive.tiles.definitions;
                return apiToUse.save(definition);
            });
        }
    });
};

/**
 * Returns a promise for detecting when the definition directory has been autowired.
 * Assumes that the definintion directory is exactly the same as the definition name, eg.:
 *
 * /tiles/my-twitter-definition
 *
 * In this case the definition name is my-twitter-definition.
 * @param definitionDir
 */
definitionSetup.setupOneDefinition = function( app, definitionDir, definitionName  ) {
    return q.nfcall( fs.stat, definitionDir ).then( function( stat ) {
        if ( stat.isDirectory() ) {
            definitionName = definitionName ||
                (definitionDir.substring( definitionDir.lastIndexOf('/') + 1, definitionDir.length ) ); /// xxx todo this might not always work! use path
            var definitionPath = definitionDir + '/definition.json';
            var routesPath = definitionDir + '/backend/routes';
            var servicesPath = definitionDir + '/backend';

            app.use( '/' + definitionName, express.static( definitionDir + '/public'  ) );

            // setup tile public directory
            var definitionApp = express();

            definitionApp.engine('html', consolidate.mustache);
            definitionApp.set('view engine', 'html');
            definitionApp.set('views', definitionDir + '/public');

            app.use( definitionApp );

            // if a definition exists, read it from disk and save it
            var definitionPromise = definitionSetup.setupDefinitionMetadata(definitionPath);

            // wire up service and routes
            return definitionPromise.then( function() {
                var promises = [];

                promises.push( fsexists(routesPath).then( function(exists) {
                    if ( exists ) {
                        return definitionSetup.setupDefinitionRoutes( definitionApp, definitionName, routesPath );
                    }
                }));

                promises.push( fsexists(definitionDir).then( function(exists) {
                    if ( exists ) {
                        return definitionSetup.setupDefinitionServices( app, definitionName, servicesPath );
                    }
                }));

                return q.all(promises);
            });
        } else {
            return q.resolve();
        }
    }).catch( function(e) {
        jive.logger.error("Failed to setup tile at " + definitionName + "; " + e);
        process.exit(-1);
    });
};

/**
 * Autowires each definition discovered in the provided definitions directory.
 * @param definitionsRootDir
 * @return {*}
 */
definitionSetup.setupAllDefinitions = function( app, definitionsRootDir ) {
    return jive.util.fsexists( definitionsRootDir).then( function(exists) {
        if ( exists ) {
            return q.nfcall(fs.readdir, definitionsRootDir).then(function(dirContents){
                var proms = [];
                dirContents.forEach(function(item) {
                    if ( !isValidFile(item) ) {
                        return;
                    }
                    var dirPath = definitionsRootDir + '/' + item ;
                    proms.push(definitionSetup.setupOneDefinition(app, dirPath));
                });

                return q.all(proms);
            });
        } else {
            return q.resolve();
        }
    }).then( function () {
        // make sure that all definitions in the db actually still exist
        var remove = function(libraryToUse) {
            return libraryToUse.findAll().then( function (allDefinitions) {
                var proms = [];
                allDefinitions.forEach(function (tile) {
                    var definitionDir = tile['definitionDirName'];
                    if ( definitionDir ) {
                        proms.push(
                            jive.util.fsexists( definitionsRootDir + '/' + definitionDir).then( function(exists) {
                                return !exists ? libraryToUse.remove( tile['id']) : q.resolve();
                            })
                        );
                    }
                    return q.resolve();
                });

                return q.all(proms);
            });
        };

        return remove( jive.tiles.definitions).then( function() {
           return remove( jive.extstreams.definitions );
        });
    });

};