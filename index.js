var fs = require('fs');
var async = require('async');
var path = require('path');
var archy = require('archy');
var readjson = require('read-cortex-json');
var semver = require('semver');
var shrinkwrap = require('cortex-shrinkwrap');
var colors = require('ansicolors');

module.exports = lsTree;

module.exports.print = function(cwd, options, callback) {
	var json = options.json;

	lsTree(cwd, options, function(err, tree, unmets, exts) {
		if (err) return callback(err);

		if (json)
			return callback(null, JSON.stringify(tree, null, 2));

		// archy
		var out = makeArchy(tree.name, tree, unmets);
		if (exts && exts.length) {
			exts.forEach(function(ext) {
				out.nodes.push({
					label: colors.green('EXTRANEOUS DEPENDENCY ') + ext
				});
			});
		}

		callback(err, archy(out));
	});
};


function lsTree(cwd, options, callback) {
	if (typeof options == 'function') {
		callback = options;
		options = undefined;
	}

	options = options || {};

	var filters = options.filters || [];

	filters = filters.map(function(a) {
		var nv = a.split("@");
		var name = nv.shift();
		var ver = semver.validRange(nv.join("@")) || "";

		return {
			name: name,
			version: ver
		};
	});

	var depth = options.depth || Infinity;

	var built_root = path.join(cwd, 'neurons');

	fs.readdir(built_root, function(err, files) {
		if (err) return callback(err);
		async.filter(files, function(file, cb) {
			fs.stat(path.join(built_root, file), function(err, stat) {
				if (err) return cb();
				cb(stat.isDirectory());
			});
		}, function(packages) {
			async.map(packages.map(function(name) {
				return path.join(built_root, name);
			}), fs.readdir, function(err, vers) {
				if (err) return callback(err);
				// find all available packages
				var avails = {};
				packages.forEach(function(name, idx) {
					// hard code escape neuron engine
					if (name != 'neuron') {
						vers[idx].forEach(function(version) {
							avails[name + '@' + version] = true;
						});
					}
				});

				// get tree
				readjson.enhanced(cwd, function(err, pkg) {
					if (err) return callback(err);

					var traveller = shrinkwrap(pkg, built_root, {
						stop_on_error: false,
						async: true,
						dev: true
					}, function(err, tree) {
						if (err) return callback(err);

						var n;
						var queue = [{
							name: tree.name,
							node: tree
						}];
						while (n = queue.shift()) {
							if (n && n.node) {

								var name = n.name;
								var version = n.node.version;
								delete avails[name + '@' + version];

								[n.node.dependencies, n.node.asyncDependencies, n.node.devDependencies].forEach(function(deps) {
									if (deps) {
										Object.keys(deps).forEach(function(name) {
											queue.push({
												name: name,
												node: deps[name]
											});
										});
									}
								});
							}
						}

						// find extraneous
						var exts = Object.keys(avails);


						tree = filterTree(cutTree(tree, depth), filters);
						delete tree._found;
						callback(null, tree, unmets, exts);
					});

					// unmet dependencies
					var unmets = {};
					traveller.on('unmet', function(name, range, pname, pver, pfrom) {
						if (filters && filters.length) {
							var found = false;
							for (var i = 0; !found && i < filters.length; i++) {
								if (name === filters[i].name) {
									found = semver.satisfies(range, filters[i].version, true);
								}
							}

							if (!found) return;
						}

						var p = unmets[pname] = unmets[pname] || {};
						var v = p[pver] = p[pver] || {};

						var n = v[name] = v[name] || {};
						n[range] = true;
					});
				});
			});
		});
	});
}


function cutTree(root, depth) {
	if (depth === Infinity) return root;

	if (depth === 0) {
		delete root.dependencies;
		delete root.asyncDependencies;
		delete root.devDependencies;
		return root;
	}

	[root.dependencies, root.asyncDependencies, root.devDependencies].forEach(function(deps) {
		if (deps) {
			Object.keys(deps).forEach(function(name) {
				deps[name] = cutTree(deps[name], depth - 1);
			});
		}
	});

	return root;
}


function filterTree(root, filters) {
	if (!filters.length) return root;


	[root.dependencies, root.asyncDependencies, root.devDependencies].forEach(function(deps) {
		if (deps) {
			// for each dependency, tell whether it's in path
			Object.keys(deps).forEach(function(name) {
				var dep = filterTree(deps[name], filters);

				var found = false;
				for (var i = 0; !found && i < filters.length; i++) {
					if (name === filters[i].name) {
						found = semver.satisfies(dep.version, filters[i].version, true);
					}
				}

				// included explicitly
				if (found) dep._found = true;

				// included because a child was included
				if (dep._found && !root._found) root._found = true;

				// not included
				if (!dep._found) delete deps[name];

				delete dep._found;
			});
		}
	});

	if (!root._found)
		root._found = false;
	return root;
}



function makeArchy(name, data, unmets, suffix) {
	var out = {};
	out.label = name + '@' + data.version + (suffix ? suffix : '');
	out.nodes = [];


	if (unmets[name] && unmets[name][data.version]) {
		var p = unmets[name][data.version];
		Object.keys(p).forEach(function(name) {
			Object.keys(p[name]).forEach(function(range) {
				out.nodes.push({
					label: colors.red('UNMET DEPENDENCY  ') + name + '@' + range
				});
			});
		});
	}


	// dependencies
	for (var name in data.dependencies) {
		out.nodes.push(makeArchy(name, data.dependencies[name], unmets));
	}


	// asyhnDependencies
	for (var name in data.asyncDependencies) {
		out.nodes.push(makeArchy(name, data.asyncDependencies[name], unmets, colors.brightCyan(' (async)')));
	}

	// devDependencies
	for (var name in data.devDependencies) {
		out.nodes.push(makeArchy(name, data.devDependencies[name], unmets, colors.blue(' (dev)')));
	}

	return out;
}