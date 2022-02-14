const URL = require('url').URL
const chalk = require('chalk')

const { identifyDeployKey } = require('../command-helpers/auth')
const { createCompiler } = require('../command-helpers/compiler')
const { fixParameters } = require('../command-helpers/gluegun')
const { createJsonRpcClient } = require('../command-helpers/jsonrpc')
const { chooseNodeUrl } = require('../command-helpers/node')
const { withSpinner } = require('../command-helpers/spinner')
const { validateSubgraphName } = require('../command-helpers/subgraph')
const { DEFAULT_IPFS_URL } = require('../command-helpers/ipfs')

const HELP = `
${chalk.bold('graph deploy2')} [options] ${chalk.bold('<subgraph-name>')} ${chalk.bold(
  '[<subgraph-manifest>]',
)}

Options:

      --product <subgraph-studio|hosted-service>
                                Selects the product to which to deploy
      --studio                  Shortcut for --product subgraph-studio
  -g, --node <node>             Graph node to which to deploy
      --node2 <node>           Graph node 2 to which to deploy
      --deploy-key <key>        User deploy key
  -l  --version-label <label>   Version label used for the deployment
  -h, --help                    Show usage information
  -i, --ipfs <node>             Upload build results to an IPFS node (default: ${DEFAULT_IPFS_URL})
      --ipfs2 <node>           Upload build results to an IPFS node 2 (default: ${DEFAULT_IPFS_URL})
  -o, --output-dir <path>       Output directory for build results (default: build/)
      --skip-migrations         Skip subgraph migrations (default: false)
  -w, --watch                   Regenerate types when subgraph files change (default: false)
`

const processForm = async (
  toolbox,
  {
    product,
    studio,
    node,
    versionLabel,
  },
) => {
  const questions = [
    {
      type: 'select',
      name: 'product',
      message: 'Product for which to deploy',
      choices: ['subgraph-studio', 'hosted-service'],
      skip: 
        product === 'subgraph-studio' ||
        product === 'hosted-service' ||
        studio !== undefined || node !== undefined,
    },
    {
      type: 'input',
      name: 'versionLabel',
      message: 'Version Label (e.g. v0.0.1)',
      skip: versionLabel !== undefined,
    },
  ]

  try {
    const answers = await toolbox.prompt.ask(questions)
    return answers
  } catch (e) {
    return undefined
  }
}

module.exports = {
  description: 'Deploys the subgraph to 2 Graph node',
  run: async toolbox => {
    // Obtain tools
    let { filesystem, print, system } = toolbox

    // Parse CLI parameters
    let {
      product,
      studio,
      deployKey,
      accessToken,
      versionLabel,
      l,
      g,
      h,
      i,
      help,
      ipfs,
      ipfs2,
      node,
      node2,
      o,
      outputDir,
      skipMigrations,
      w,
      watch,
    } = toolbox.parameters.options

    // Support both long and short option variants
    help = help || h
    ipfs = ipfs || i || DEFAULT_IPFS_URL
    ipfs2 = ipfs2 || DEFAULT_IPFS_URL
    node = node || g
    outputDir = outputDir || o
    watch = watch || w
    versionLabel = versionLabel || l

    let subgraphName, manifest
    try {
      ;[subgraphName, manifest] = fixParameters(toolbox.parameters, {
        h,
        help,
        w,
        watch,
        studio
      })
    } catch (e) {
      print.error(e.message)
      process.exitCode = 1
      return
    }

    // Fall back to default values for options / parameters
    outputDir = outputDir && outputDir !== '' ? outputDir : filesystem.path('build')
    manifest =
      manifest !== undefined && manifest !== ''
        ? manifest
        : filesystem.resolve('subgraph.yaml')

    // Show help text if requested
    if (help) {
      print.info(HELP)
      return
    }

    ;({ node } = chooseNodeUrl({ product, studio, node }))
    if (!node) {
      const inputs = await processForm(toolbox, {
        product,
        studio,
        node,
        versionLabel: 'skip', // determine label requirement later
      })
      if (inputs === undefined) {
        process.exit(1)
      }
      product = inputs.product
      ;({ node } = chooseNodeUrl({
        product,
        studio,
        node,
      }))
    }

    // Validate the subgraph name
    if (!subgraphName) {
      print.error(`No subgraph ${product == 'subgraph-studio' || studio ? 'slug' : 'name'} provided`)
      print.info(HELP)
      process.exitCode = 1
      return
    }

    // Validate node
    if (!node) {
      print.error(`No Graph node provided`)
      print.info(HELP)
      process.exitCode = 1
      return
    }

    // Validate IPFS
    if (!ipfs) {
      print.error(`No IPFS node provided`)
      print.info(HELP)
      process.exitCode = 1
      return
    }

    const isStudio = node.match(/studio/)
    const isHostedService = node.match(/thegraph.com/) && !isStudio

    let compiler = createCompiler(manifest, {
      ipfs,
      outputDir,
      outputFormat: 'wasm',
      skipMigrations,
      blockIpfsMethods: isStudio  // Network does not support publishing subgraphs with IPFS methods
    })

    // Exit with an error code if the compiler couldn't be created
    if (!compiler) {
      process.exitCode = 1
      return
    }

    let compiler2
    if (ipfs2) {
      let ipfs = ipfs2
      compiler2 = createCompiler(manifest, {
        ipfs,
        outputDir,
        outputFormat: 'wasm',
        skipMigrations,
        blockIpfsMethods: isStudio  // Network does not support publishing subgraphs with IPFS methods
      })
  
      // Exit with an error code if the compiler couldn't be created
      if (!compiler2) {
        process.exitCode = 1
        return
      }
    }

    // Ask for label if not on hosted service
    if (!versionLabel && !isHostedService) {
      const inputs = await processForm(toolbox, {
        product,
        studio,
        node,
        versionLabel,
      })
      if (inputs === undefined) {
        process.exit(1)
      }
      versionLabel = inputs.versionLabel
    }

    let requestUrl = new URL(node)
    let client = createJsonRpcClient(requestUrl)

    // Exit with an error code if the client couldn't be created
    if (!client) {
      process.exitCode = 1
      return
    }

    let requestUrl2
    let client2
    if (node2) {
      requestUrl2 = new URL(node2)
      client2 = createJsonRpcClient(requestUrl2)

      // Exit with an error code if the client couldn't be created
      if (!client2) {
        process.exitCode = 1
        return
      }
    }

    // Use the deploy key, if one is set
    if (!deployKey && accessToken) {
      deployKey = accessToken // backwards compatibility
    }
    deployKey1 = await identifyDeployKey(node, deployKey)
    if (deployKey1 !== undefined && deployKey1 !== null) {
      client.options.headers = { Authorization: 'Bearer ' + deployKey1 }
    }

    if (node2) {
      deployKey2 = await identifyDeployKey(node2, deployKey)
      if (deployKey2 !== undefined && deployKey2 !== null) {
          client2.options.headers = { Authorization: 'Bearer ' + deployKey2 }
      }
    }

    let deploySubgraph = async (node, client, requestUrl, ipfsHash) => {
      let spinner = print.spin(`Deploying to Graph node ${requestUrl}`)
      //       `Failed to deploy to Graph node ${requestUrl}`,
      client.request(
        'subgraph_deploy',
        { name: subgraphName, ipfs_hash: ipfsHash, version_label: versionLabel },
        async (requestError, jsonRpcError, res) => {
          if (jsonRpcError) {
            spinner.fail(
              `Failed to deploy to Graph node ${requestUrl}: ${jsonRpcError.message}`,
            )

            // Provide helpful advice when the subgraph has not been created yet
            if (jsonRpcError.message.match(/subgraph name not found/)) {
              if (isHostedService) {
                print.info(`
You may need to create it at https://thegraph.com/explorer/dashboard.`)
              } else {
                print.info(`
Make sure to create the subgraph first by running the following command:
$ graph create --node ${node} ${subgraphName}`)
              }
            }
            process.exitCode = 1
          } else if (requestError) {
            spinner.fail(`HTTP error deploying the subgraph ${requestError.code}`)
            process.exitCode = 1
          } else {
            spinner.stop()

            const base = requestUrl.protocol + '//' + requestUrl.hostname
            let playground = res.playground
            let queries = res.queries
            let subscriptions = res.subscriptions

            // Add a base URL if graph-node did not return the full URL
            if (playground.charAt(0) === ':') {
              playground = base + playground
            }
            if (queries.charAt(0) === ':') {
              queries = base + queries
            }
            if (subscriptions.charAt(0) === ':') {
              subscriptions = base + subscriptions
            }

            if (isHostedService) {
              print.success(
                `Deployed to ${chalk.blue(
                  `https://thegraph.com/explorer/subgraph/${subgraphName}`,
                )}`,
              )
            } else {
              print.success(`Deployed to ${chalk.blue(`${playground}`)}`)
            }
            print.info('\nSubgraph endpoints:')
            print.info(`Queries (HTTP):     ${queries}`)
            print.info(`Subscriptions (WS): ${subscriptions}`)
            print.info(``)
          }
        },
      )
    }

    if (watch) {
      await compiler.watchAndCompile(async ipfsHash => {
        if (ipfsHash !== undefined) {
          await deploySubgraph(node, client, requestUrl, ipfsHash)
        }
      })
      if (compiler2) {
        await compiler2.watchAndCompile(async ipfsHash => {
            if (ipfsHash !== undefined && client2) {
              await deploySubgraph(node2, client2, requestUrl2, ipfsHash)
            }
          })        
      }
    } else {
      let result = await compiler.compile()
      if (result === undefined || result === false) {
        // Compilation failed, not deploying.
        process.exitCode = 1
        return
      }
      if (compiler2) {
        let result2 = await compiler2.compile()
        if (result2 === undefined || result2 === false) {
          // Compilation failed, not deploying.
          process.exitCode = 1
          return
        }
        // result is ipfs hash, should be same
        assert(result, result2)
      }

      // nofity graph node now because graph node may connect nginx which load these 2 ipfs node.
      await deploySubgraph(node, client, requestUrl, result)
      if (client2) {
        await deploySubgraph(node2, client2, requestUrl2, result)
      }
    }
  },
}
