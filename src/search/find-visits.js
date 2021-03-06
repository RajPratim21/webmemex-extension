import fromPairs from 'lodash/fp/fromPairs'
import update from 'lodash/fp/update'
import reverse from 'lodash/fp/reverse'
import unionBy from 'lodash/unionBy' // the fp version does not support >2 inputs (lodash issue #3025)
import sortBy from 'lodash/fp/sortBy'
import {ourState} from '../overview/selectors'
import store from '../overview/main'
import moment from 'moment';

import db, { normaliseFindResult, resultRowsById }  from 'src/pouchdb'
import { convertVisitDocId, visitKeyPrefix, getTimestamp } from 'src/activity-logger'
import { getPages } from './find-pages'


// Nest the page docs into the visit docs, and return the latter.
function insertPagesIntoVisits({visitsResult, pagesResult, presorted=false}) {
    // If pages are not already passed to us, get them and call ourselves again.
    if (pagesResult === undefined) {
        // Get the page of each visit.
        const pageIds = visitsResult.rows.map(row => row.doc.page._id)
        return getPages({
            pageIds,
            // Assume that we always want to follow redirects.
            followRedirects: true,
        }).then(pagesResult =>
            // Invoke ourselves with the found pages.
            insertPagesIntoVisits({visitsResult, pagesResult, presorted: true})
        )
    }

    if (presorted) {
        // A small optimisation if the results already match one to one.
        return update('rows', rows => rows.map(
            (row, i) => update('doc.page', ()=>pagesResult.rows[i].doc)(row)
        ))(visitsResult)
    }
    else {
        // Read each visit's doc.page._id and replace it with the specified page.
        const pagesById = resultRowsById(pagesResult)
        return update('rows', rows => rows.map(
            update('doc.page', page => pagesById[page._id].doc)
        ))(visitsResult)
    }
}

// Get the most recent visits, each with the visited page already nested in it.
export function getLastVisits({
    limit
}={}) {
    return db.find({
        selector: {
            // workaround for lack of startkey/endkey support
            _id: { $gte: visitKeyPrefix, $lte: `${visitKeyPrefix}\uffff`}
        },
        sort: [{_id: 'desc'}],
        limit,
    }).then(
        normaliseFindResult
    ).then(
        visitsResult => insertPagesIntoVisits({visitsResult})
    )
}


// Find all visits to the given pages, return them with the pages nested inside.
// Resulting visits are sorted by time, descending.
// XXX: If pages are redirected, only visits to the source page are found.
export function findVisitsToPages({pagesResult}) {
    const pageIds = pagesResult.rows.map(row => row.id)
   /**
     * Here the whole data range values (StartDate and endDates) are accessed that are bieng updated 
     * by Overview.jsx via date-picker . if they are not updated i.e user didn't seleceted any of them 
     * then the startDate is intialized with default value of 100 days past and endDate is intialized 
     * with present date.  if only one is selected other is initializedd with  it's default value.
     * inside db,find we are  fetching only these data values that are between staertDate and endDate.
     * Raj Pratim Bhattacharya gmail rajpratim1234@gmail.com
     */
    
    var current_time = new moment().valueOf();
    var startDate = current_time - 100*24*60*60*1000; //100 days old search
    var endDate =  current_time;

    if(ourState(store.getState()).startDate!=null)
    {   
        //if startDate has been updated by user then it's updates else default value is used
        startDate = ourState(store.getState()).startDate.format('x');
    }

    if(ourState(store.getState()).endDate!=null)
    {
        //if endDate has been updated by user then it's updates else default value is used
        endDate = ourState(store.getState()).endDate.format('x');
    }
    
    return db.find({
        // Find the visits that contain the pages
        selector: {
            'page._id': {$in: pageIds},
            // workaround for lack of startkey/endkey support
        _id: { $gte: convertVisitDocId({timestamp: startDate}),
                         $lte: convertVisitDocId({timestamp:endDate})} 
   
    },
    
        // Sort them by time, newest first
        sort: [{'_id': 'desc'}],
    }).then(
        normaliseFindResult
    ).then(visitsResult =>
        insertPagesIntoVisits({visitsResult, pagesResult})
    )
}

// Expand the results, adding a bit of context around each visit.
// Currently context means a few preceding and succeding visits.
export function addVisitsContext({
    visitsResult,
    maxPrecedingVisits=2,
    maxSuccedingVisits=2,
    maxPrecedingTime = 1000*60*20,
    maxSuccedingTime = 1000*60*20,
}) {
    // For each visit, get its context.
    const promises = visitsResult.rows.map(row => {
        const timestamp = getTimestamp(row.doc)
        // Get preceding visits
        return db.allDocs({
            include_docs: true,
            // Subtract 1ms to exclude itself (there is no include_start option).
            startkey: convertVisitDocId({timestamp: timestamp-1}),
            endkey: convertVisitDocId({timestamp: timestamp-maxPrecedingTime}),
            descending: true,
            limit: maxPrecedingVisits,
        }).then(prequelResult => {
            // Get succeeding visits
            return db.allDocs({
                include_docs: true,
                // Add 1ms to exclude itself (there is no include_start option).
                startkey: convertVisitDocId({timestamp: timestamp+1}),
                endkey: convertVisitDocId({timestamp: timestamp+maxSuccedingTime}),
                limit: maxSuccedingVisits,
            }).then(sequelResult => {
                // Combine them as if they were one result.
                return {
                    rows: prequelResult.rows.concat(reverse(sequelResult.rows))
                }
            })
        }).then(contextResult =>
            // Insert pages as usual.
            insertPagesIntoVisits({visitsResult: contextResult})
        ).then(
            // Mark each row as being a 'contextual result'.
            update('rows', rows =>
                rows.map(row => ({...row, isContextualResult: true}))
            )
        )
    })
    // When the context of each visit has been retrieved, merge and return them.
    return Promise.all(promises).then(contextResults =>
        // Insert the contexts (prequels+sequels) into the original results
        update('rows', rows => {
            // Concat all results and all their contexts, but remove duplicates.
            const allRows = unionBy(
                rows,
                ...contextResults.map(result => result.rows),
                'id' // Use the visits' ids as the uniqueness criterion
            )
            // Sort them again by timestamp
            return sortBy(row => -getTimestamp(row.doc))(allRows)
        })(visitsResult)
    )
}
