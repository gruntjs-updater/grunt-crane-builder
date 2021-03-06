var fs = require('fs');
var promise = require('../util/promise');
var ProgressBar = require('progress');

module.exports = function ( grunt ) {
    var src       = grunt.config('src');
    var dest      = grunt.config('dest');
    var taskToken = grunt.option('token') || Date.now();

    process.on('uncaughtException', function(err) {
        console.log('Caught exception: ' + err, err.stack);
    });

    try {
        grunt.db = grunt.file.readJSON('db.json');
    } catch (ex) {
        grunt.db = {
            files: {}
        };
    }

    grunt.db.save = function () {
        grunt.file.write('db.json', JSON.stringify(grunt.db, null, 4));
    };

    grunt.db.save();

    var builders  = grunt.config.getRaw('builder').map(function (builder) {
        return [builder[0], builder[1](grunt)];
    });

    grunt.registerTask('crane_builder', function () {
        var files = [].slice.call( arguments );
        var report = {
            token: taskToken
        };

        /* 整理文件列表 */

        // 如果没有提供文件列表则编译全部文件
        if (!files.length) {
            grunt.log.writeln('');
            grunt.log.write('Listing all files...');
            files = grunt.file
                .expand({filter: function (path) {
                    return grunt.file.isFile(path);
                }}, src + '**/*')
                .map(function (path) {
                    return path.replace(src, '');
                });
        } else {
            // 如果有文件夹，则取出该文件夹下的所有文件
            var dirs = files.filter(function (file) {
                return grunt.file.isDir(src + file);
            });

            files = grunt.util._.difference(files, dirs);

            files = files.concat(grunt.util._.flatten(dirs.map(function (dir) {
                return grunt.file
                    .expand({
                        filter: function (path) {
                            return grunt.file.isFile(path);
                        }
                    }, src + dir + '/**/*')
                    .map(function (path) {
                        return path.replace(src, '');
                    });
            })));
        }

        report.input = [].concat(files);

        /* 检查被影响到的额外文件 */
        var searchList = files;
        var allFiles = grunt.db.files;
        var allFilesKey = Object.keys(allFiles);

        while(searchList.length) {
            searchList = searchList.reduce(function (list, search) {
                if (files.indexOf(search) === -1) {
                    files.push(search);
                }

                allFilesKey
                    .filter(function (f) {
                        if (!allFiles[f].children) {
                            return false;
                        }

                        return allFiles[f].children.indexOf(search) !== -1 &&
                            files.indexOf(f) === -1 &&
                            list.indexOf(f) === -1;
                    })
                    .forEach(function (f) {
                        // push 至list内以供下次搜索
                        list.push(f);
                    });

                return list;
            }, []);
        }

        report.files = files;

        /* 开始编译 */
        report.build = {};
        report.fail  = {};
        report.warning = {};

        // 将config.json移到到每次编译的末尾
        if (files.indexOf('config.json') !== -1) {
            files = grunt.util._.without(files, 'config.json');
            files.push('config.json');
        }

        var done = this.async();

        console.time('Spent');

        var bar = new ProgressBar('Building: [:bar](:current / :total) :percent', {
            total: files.length,
            width: 30,
            complete: "*",
            incomplete: " "
        });

        var defers = files.map(function (file) {
            var Builder, builder, i, defer;

            for (i = 0; i < builders.length; i++) {
                if (grunt.file.isMatch(builders[i][0], file)) {
                    Builder = builders[i][1];
                    break;
                }
            }

            if (!Builder) {
                return;
            }

            if (!grunt.db.files[file]) {
                grunt.db.files[file] = {};
            }

            builder = new Builder(file);

            try {
                defer = builder.build();
            } catch (ex) {
                defer = promise.Deferred().reject(ex.message + ex.stack.toString()).promise();
            }
            return defer
                .done(function (outputFileList, info) {
                    if (builder.isCmbFile && builder.isCmbFile()) {
                        grunt.db.files[file].children = builder.getChildren(file);
                    }

                    outputFileList = outputFileList || [];

                    outputFileList.forEach(function (file) {
                        if (!fs.existsSync(dest + file)) {
                            return;
                        }

                        var timestamp = +fs.statSync(dest + file).mtime;

                        grunt.db.files[file] = grunt.db.files[file] || {};

                        grunt.db.files[file].timestamp = timestamp;
                        report.build[file] = {'timestamp' : timestamp};
                    });

                    if (info) {
                        report[info.type][file] = info.text;
                    }

                    bar.tick();
                })
                .fail(function (msg) {
                    report.fail[file] = msg;
                });
        });

        promise.when(defers)
            .all.finish(function () {
                var warningCount = Object.keys(report.warning).length;
                var failCount = Object.keys(report.fail).length;

                grunt.log.write('Compiled %d Files, ', defers.length);
                console.timeEnd('Spent');
                grunt.db.save();
                grunt.file.write('reports/' + report.token, JSON.stringify(report, null, 4));

                if (warningCount) {
                    grunt.log.writeln('');
                    grunt.log.writeln('');
                    grunt.log.writeln('Build finish with %d Warnings'.red, warningCount);
                    for (var index in report.warning) {
                      grunt.log.writeln('>>', report.warning[index].bold.magenta + ' in ' + index.cyan);
                    }
                    grunt.log.writeln('');
                    grunt.log.writeln('');
                }

                if (failCount) {
                    grunt.log.writeln('');
                    grunt.log.writeln('');
                    grunt.log.writeln('Build finish with %d Errors'.red, failCount);
                    for (var index in report.fail) {
                      grunt.log.writeln('>>', report.fail[index].bold.magenta + ' in ' + index.cyan);
                    }
                    grunt.log.writeln('');
                    grunt.log.writeln('');
                    done(false);
                } else {
                    done(true);
                }
            });
    });
};
